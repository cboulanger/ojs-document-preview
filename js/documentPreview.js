/**
 * plugins/generic/documentPreview/js/documentPreview.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * The core of the preview: finds the links to OJS's file download handler, adds a
 * "Preview" button for files that a registered renderer can read, and shows the
 * renderer's HTML in a dialog, in a sandboxed iframe (no scripts, no access to the
 * page, no external resources). The file is loaded through the same download link,
 * so OJS checks access exactly as for a download.
 *
 * Links: those with the URL in href (Vue components, e.g. the workflow's file lists)
 * and link actions of the older grids (e.g. discussions, the reviewer's files), which
 * have href="#" and the URL in the script that follows them. OJS's Vue components
 * render file lists after page load and re-render them, so the page is watched.
 *
 * Which renderer: by the extension of the file name (the link text). If the name has
 * no extension (OJS allows any name, also an empty one), one HEAD request to the
 * download link tells the file's media type.
 *
 * Renderers (see js/renderers/docx.js) register themselves:
 *
 *   window.documentPreview.register('docx', {
 *     // buffer: the file (ArrayBuffer); options: from the plugin's PHP configuration;
 *     // file: {name, url}. Returns (a promise of) the document's body as HTML.
 *     render: function (buffer, options, file) { ... }
 *   });
 *
 * or, for formats with a viewer of their own (js/renderers/pdf.js), with
 *
 *     // Returns the URL of a page (on the same server) that shows the file at url
 *     page: function (url, options, file) { ... }
 *
 * instead of render. The core doesn't load the file then: the page does. The page
 * runs with scripts and the page's origin, so it must be trusted code, and it can't
 * navigate the OJS page.
 *
 * and can use documentPreview.loadScript(url) to load libraries on first use and
 * documentPreview.unsupported() for files they can't read. The formats a renderer
 * reads are configured in PHP (DocumentPreviewPlugin::getRenderers()).
 */
(function () {
	'use strict';

	var config = window.documentPreviewConfig;
	if (!config || !window.fetch || !window.MutationObserver || !window.HTMLDialogElement) {
		return;
	}
	var text = config.text;
	var LINK_SELECTOR = 'a[href*="download-file"], a.pkp_linkaction_downloadFile';
	var URL_OPTION = /"url":\s*("(?:[^"\\]|\\.)*")/;
	var BUTTON_CLASS = 'documentPreview__button';
	// What counts as a file name extension: a dot and 2-5 characters, starting
	// with a letter (".2024" in "Final_15.03.2024" is not one)
	var EXTENSION = /\.([a-z][a-z0-9]{1,4})$/i;
	var PROBES_AT_ONCE = 3;

	var renderers = {}; // id => {render}, registered by the renderer scripts
	var mediaTypes = {}; // file key (see fileKey) => media type; null while probing
	var probeQueue = [];
	var probesRunning = 0;
	var scripts = {};
	var started = false;

	// --- Registration API ---------------------------------------------------------

	window.documentPreview = {
		register: function (id, renderer) {
			if (!config.renderers[id] || (typeof renderer.render !== 'function' && typeof renderer.page !== 'function')) {
				return;
			}
			renderers[id] = renderer;
			if (started) {
				scan(document.body);
			}
		},

		/**
		 * Load a script once (e.g. a library a renderer needs). Hides an AMD loader
		 * while the script runs, so that UMD libraries set their global variable.
		 */
		loadScript: function (url) {
			if (!scripts[url]) {
				scripts[url] = new Promise(function (resolve, reject) {
					var define = window.define;
					window.define = undefined;
					var script = document.createElement('script');
					script.src = url;
					script.onload = function () {
						window.define = define;
						resolve();
					};
					script.onerror = function () {
						window.define = define;
						script.remove();
						delete scripts[url];
						reject(new Error('Could not load ' + url));
					};
					document.head.appendChild(script);
				});
			}
			return scripts[url];
		},

		/**
		 * The error a renderer throws for a file it can't read (the dialog then
		 * says so and offers the download).
		 */
		unsupported: function (message) {
			var error = new Error(message || 'unsupported file');
			error.unsupported = true;
			return error;
		}
	};

	// --- Finding the renderer for a link -----------------------------------------

	function fileName(a) {
		return (a.textContent || '').trim();
	}

	/**
	 * The download URL of a link, or null.
	 */
	function downloadUrl(a) {
		if ((a.getAttribute('href') || '').indexOf('download-file') !== -1) {
			return a.href;
		}
		// Grid link action: the options of the script after the link contain the URL
		var script = a.nextElementSibling;
		while (script && script.tagName !== 'SCRIPT') {
			script = script.nextElementSibling;
		}
		var match = script && URL_OPTION.exec(script.textContent);
		if (match) {
			try {
				var url = JSON.parse(match[1]);
				return url.indexOf('download-file') !== -1 ? url : null;
			} catch (e) {
				return null;
			}
		}
		return null;
	}

	/**
	 * The same file has differently built URLs in different lists (with or without
	 * the revision); its key is the submission file.
	 */
	function fileKey(url) {
		try {
			return new URL(url, document.baseURI).searchParams.get('submissionFileId') || url;
		} catch (e) {
			return url;
		}
	}

	function rendererFor(property, value) {
		for (var id in renderers) {
			if (config.renderers[id][property].indexOf(value) !== -1) {
				return id;
			}
		}
		return null;
	}

	/**
	 * The id of the renderer for a link: by the file name's extension, else by the
	 * media type if it is already known. undefined: not known yet (being probed).
	 */
	function rendererOf(a, url) {
		var ext = EXTENSION.exec(fileName(a));
		if (ext) {
			return rendererFor('extensions', ext[1].toLowerCase());
		}
		var type = mediaTypes[fileKey(url)];
		if (typeof type === 'string') {
			return rendererFor('mimeTypes', type);
		}
		probe(url);
		return undefined;
	}

	/**
	 * Ask the download handler for the file's media type (HEAD request, a few at
	 * a time), then look at the links to that file again.
	 */
	function probe(url) {
		var key = fileKey(url);
		if (key in mediaTypes) {
			return;
		}
		mediaTypes[key] = null;
		probeQueue.push(url);
		nextProbe();
	}

	function nextProbe() {
		if (probesRunning >= PROBES_AT_ONCE || !probeQueue.length) {
			return;
		}
		var url = probeQueue.shift();
		var key = fileKey(url);
		probesRunning++;
		fetch(url, {method: 'HEAD', credentials: 'same-origin'}).then(function (response) {
			var type = response.ok ? (response.headers.get('Content-Type') || '') : '';
			mediaTypes[key] = type.split(';')[0].trim().toLowerCase();
		}, function () {
			mediaTypes[key] = '';
		}).then(function () {
			probesRunning--;
			Array.prototype.forEach.call(document.querySelectorAll(LINK_SELECTOR), function (a) {
				var other = downloadUrl(a);
				if (other && fileKey(other) === key) {
					sync(a);
				}
			});
			nextProbe();
		});
	}

	// --- Buttons ------------------------------------------------------------------

	/**
	 * The button goes before the file name, so that it stays visible when OJS
	 * truncates a long name (the file lists cut off what doesn't fit in the cell).
	 * If the link is wrapped in an element of its own, before that element.
	 */
	function anchorOf(a) {
		var parent = a.parentElement;
		if (parent && parent.children.length === 1 && !/^(TD|TH|LI|P|DIV)$/.test(parent.tagName)) {
			return parent;
		}
		return a;
	}

	function label(a) {
		return text.previewOf.replace('%s', fileName(a) || text.file);
	}

	/**
	 * Add the button for a link to a file that a renderer reads, remove it if the
	 * link (reused by Vue) now points to another file.
	 */
	function sync(a) {
		// Not the download link in the preview dialog itself
		if (a.closest('.documentPreview')) {
			return;
		}
		var button = a.documentPreviewButton && a.documentPreviewButton.isConnected ? a.documentPreviewButton : null;
		var url = downloadUrl(a);
		var id = url ? rendererOf(a, url) : null;
		if (!id) {
			if (button) {
				button.remove();
			}
			a.documentPreviewButton = null;
			return;
		}
		if (!button) {
			button = document.createElement('button');
			button.type = 'button';
			button.className = BUTTON_CLASS;
			// Icon only (FontAwesome, loaded by OJS), so that the file name keeps the room
			var icon = document.createElement('span');
			icon.className = 'fa fa-eye';
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			button.documentPreviewLink = a;
			button.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				var current = downloadUrl(a);
				var renderer = current && rendererOf(a, current);
				if (renderer) {
					openPreview(a, current, renderer);
				}
			});
			anchorOf(a).insertAdjacentElement('beforebegin', button);
			a.documentPreviewButton = button;
		}
		button.setAttribute('aria-label', label(a));
		button.title = text.preview;
	}

	/**
	 * Remove buttons whose link is gone (re-rendered by Vue or the grid).
	 */
	function removeOrphans() {
		Array.prototype.forEach.call(document.querySelectorAll('.' + BUTTON_CLASS), function (button) {
			var link = button.documentPreviewLink;
			if (!link || !link.isConnected || link.documentPreviewButton !== button) {
				button.remove();
			}
		});
	}

	function scan(root) {
		if (root.matches && root.matches(LINK_SELECTOR)) {
			sync(root);
		}
		if (root.querySelectorAll) {
			Array.prototype.forEach.call(root.querySelectorAll(LINK_SELECTOR), sync);
		}
	}

	// --- Dialog -------------------------------------------------------------------

	function fetchFile(url) {
		return fetch(url, {credentials: 'same-origin'}).then(function (response) {
			if (!response.ok) {
				throw new Error('HTTP ' + response.status);
			}
			return response.arrayBuffer();
		});
	}

	/**
	 * Links to other documents open in a new tab; links within the document (notes)
	 * stay in the preview.
	 */
	function prepareLinks(html) {
		var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
		Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
			if (a.getAttribute('href').charAt(0) !== '#') {
				a.setAttribute('target', '_blank');
				a.setAttribute('rel', 'noopener noreferrer');
			}
		});
		return doc.body.innerHTML;
	}

	function documentHtml(body) {
		// The base keeps links within the document (#footnote-1) in it: without it, Firefox
		// and Safari resolve them against the OJS page and load that page into the frame.
		return '<!DOCTYPE html><html><head><meta charset="utf-8"><base href="about:srcdoc">' +
			'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
			'<style>' +
			'body{font-family:Georgia,"Times New Roman",serif;font-size:17px;line-height:1.6;color:#222;background:#fff;max-width:46rem;margin:0 auto;padding:2rem 1.5rem 4rem;overflow-wrap:break-word}' +
			'h1,h2,h3,h4,h5,h6{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.25}' +
			'img{max-width:100%;height:auto}' +
			'table{border-collapse:collapse;margin:1em 0;max-width:100%}' +
			'td,th{border:1px solid #bbb;padding:.3em .6em;vertical-align:top}' +
			'td p,th p{margin:.2em 0}' +
			'a{color:#006798}' +
			'li[id^="footnote-"],li[id^="endnote-"]{font-size:.9em}' +
			'</style></head><body>' + body + '</body></html>';
	}

	function element(tag, className, content) {
		var el = document.createElement(tag);
		el.className = className;
		if (content) {
			el.textContent = content;
		}
		return el;
	}

	function openPreview(link, url, rendererId) {
		var name = fileName(link) || text.file;
		var renderer = renderers[rendererId];
		var rendererConfig = config.renderers[rendererId];
		var file = {name: name, url: url};
		var dialog = element('dialog', 'documentPreview');
		dialog.setAttribute('aria-label', label(link));

		var header = element('div', 'documentPreview__header');
		var download = element('a', 'documentPreview__action', text.download);
		download.href = url;
		var close = element('button', 'documentPreview__action documentPreview__close', text.close);
		close.type = 'button';
		close.addEventListener('click', function () {
			dialog.close();
		});
		header.appendChild(element('h2', 'documentPreview__title', name));
		header.appendChild(download);
		header.appendChild(close);

		var status = element('p', 'documentPreview__status', text.loading);
		status.setAttribute('role', 'status');

		var frame = element('iframe', 'documentPreview__frame');
		if (renderer.page) {
			// A viewer page from this server (trusted code): scripts and its own origin,
			// so it can load the file, but no navigating the OJS page
			frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals ' +
				'allow-downloads allow-popups allow-popups-to-escape-sandbox');
			frame.setAttribute('allow', 'fullscreen');
		} else {
			// The converted document: no scripts, no access to the page
			frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
		}
		frame.title = label(link);
		frame.hidden = true;

		dialog.appendChild(header);
		if (rendererConfig.notice) {
			dialog.appendChild(element('p', 'documentPreview__notice', text.notice));
		}
		dialog.appendChild(status);
		dialog.appendChild(frame);

		// Keep Escape from also closing OJS's own modal underneath; the dialog's
		// default action (closing itself) still happens.
		dialog.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') {
				e.stopPropagation();
			}
		});
		// A click on the backdrop closes the dialog
		dialog.addEventListener('click', function (e) {
			if (e.target === dialog) {
				dialog.close();
			}
		});
		dialog.addEventListener('close', function () {
			dialog.remove();
			if (document.contains(link)) {
				link.focus();
			}
		});

		// Inside OJS's open modal, if any, so that its focus trap lets the dialog have the focus
		(link.closest('[role="dialog"]') || document.body).appendChild(dialog);
		dialog.showModal();
		close.focus();

		var shown;
		if (renderer.page) {
			// The page shows its own progress and errors
			shown = Promise.resolve(renderer.page(url, rendererConfig.options, file)).then(function (pageUrl) {
				frame.src = pageUrl;
			});
		} else {
			shown = fetchFile(url).then(function (buffer) {
				return renderer.render(buffer, rendererConfig.options, file);
			}).then(function (html) {
				frame.srcdoc = documentHtml(prepareLinks(String(html)));
			});
		}
		shown.then(function () {
			frame.hidden = false;
			status.hidden = true;
		}).catch(function (error) {
			status.textContent = error && error.unsupported ? text.unsupported : text.error;
			status.classList.add('documentPreview__status--error');
			if (window.console) {
				console.warn('Document Preview:', error);
			}
		});
	}

	// --- Start --------------------------------------------------------------------

	function start() {
		started = true;
		scan(document.body);
		new MutationObserver(function (mutations) {
			if (mutations.some(function (m) { return m.removedNodes.length; })) {
				removeOrphans();
			}
			mutations.forEach(function (m) {
				if (m.type === 'characterData') {
					// Vue changed a link's text only
					var a = m.target.parentElement && m.target.parentElement.closest(LINK_SELECTOR);
					if (a) {
						sync(a);
					}
					return;
				}
				Array.prototype.forEach.call(m.addedNodes, function (node) {
					if (node.nodeType === 1) {
						scan(node);
					} else if (node.nodeType === 3 && node.parentElement) {
						var link = node.parentElement.closest(LINK_SELECTOR);
						if (link) {
							sync(link);
						}
					}
				});
			});
		}).observe(document.body, {childList: true, subtree: true, characterData: true});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
