/**
 * plugins/generic/msWordViewer/js/msWordViewer.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * Adds a "Preview" button after every link to OJS's file download handler whose
 * text is a file name ending in .docx: links with the URL in href (Vue components,
 * e.g. the workflow's file lists) and link actions of the older grids (e.g.
 * discussions, the reviewer's files), which have href="#" and the URL in the
 * script that follows them. The button opens a dialog that loads the
 * file through that same link (so OJS checks access as for a download), converts
 * it to HTML with mammoth.js and shows the result in a sandboxed iframe: no scripts,
 * no access to the page, no external resources.
 *
 * OJS's Vue components render file lists after page load and re-render them, so the
 * page is watched for changes. mammoth.js is loaded on the first preview only.
 */
(function () {
	'use strict';

	var config = window.msWordViewerConfig;
	if (!config || !window.fetch || !window.MutationObserver || !window.HTMLDialogElement) {
		return;
	}
	var text = config.text;
	var LINK_SELECTOR = 'a[href*="download-file"], a.pkp_linkaction_downloadFile';
	var URL_OPTION = /"url":\s*("(?:[^"\\]|\\.)*")/;
	var BUTTON_CLASS = 'msWordViewer__button';
	var DOCX = /\.docx$/i;
	var mammothPromise = null;

	function fileName(a) {
		return (a.textContent || '').trim();
	}

	/**
	 * The download URL of a link, or null.
	 */
	function downloadUrl(a) {
		if (a.getAttribute('href').indexOf('download-file') !== -1) {
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
	 * Add the button after a link to a .docx file, remove it if the link (reused by
	 * Vue) now points to another kind of file.
	 */
	function sync(a) {
		var next = a.nextElementSibling;
		var button = next && next.classList.contains(BUTTON_CLASS) ? next : null;
		var name = fileName(a);
		if (!DOCX.test(name) || !downloadUrl(a)) {
			if (button) {
				button.remove();
			}
			return;
		}
		if (!button) {
			button = document.createElement('button');
			button.type = 'button';
			button.className = BUTTON_CLASS;
			button.textContent = text.preview;
			button.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				openPreview(button.previousElementSibling);
			});
			a.insertAdjacentElement('afterend', button);
		}
		button.setAttribute('aria-label', text.previewOf.replace('%s', name));
	}

	function scan(root) {
		if (root.matches && root.matches(LINK_SELECTOR)) {
			sync(root);
		}
		if (root.querySelectorAll) {
			Array.prototype.forEach.call(root.querySelectorAll(LINK_SELECTOR), sync);
		}
	}

	function loadMammoth() {
		if (window.mammoth) {
			return Promise.resolve(window.mammoth);
		}
		if (!mammothPromise) {
			mammothPromise = new Promise(function (resolve, reject) {
				// mammoth's UMD wrapper registers with an AMD loader instead of setting
				// window.mammoth if there is one; hide it while the script runs.
				var define = window.define;
				window.define = undefined;
				var script = document.createElement('script');
				script.src = config.mammothUrl;
				script.onload = function () {
					window.define = define;
					if (window.mammoth) {
						resolve(window.mammoth);
					} else {
						reject(new Error('mammoth.js not available'));
					}
				};
				script.onerror = function () {
					window.define = define;
					script.remove();
					mammothPromise = null;
					reject(new Error('mammoth.js could not be loaded'));
				};
				document.head.appendChild(script);
			});
		}
		return mammothPromise;
	}

	function fetchFile(url) {
		return fetch(url, {credentials: 'same-origin'}).then(function (response) {
			if (!response.ok) {
				throw new Error('HTTP ' + response.status);
			}
			return response.arrayBuffer();
		}).then(function (buffer) {
			// A .docx file is a zip archive ("PK"); anything else (an old .doc file
			// renamed, an error page) can't be converted.
			var bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
			if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
				var error = new Error('not a .docx file');
				error.notDocx = true;
				throw error;
			}
			return buffer;
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
		return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
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

	function openPreview(link) {
		var name = fileName(link);
		var url = downloadUrl(link);
		var dialog = element('dialog', 'msWordViewer');
		dialog.setAttribute('aria-label', text.previewOf.replace('%s', name));

		var header = element('div', 'msWordViewer__header');
		var download = element('a', 'msWordViewer__action', text.download);
		download.href = url;
		var close = element('button', 'msWordViewer__action msWordViewer__close', text.close);
		close.type = 'button';
		close.addEventListener('click', function () {
			dialog.close();
		});
		header.appendChild(element('h2', 'msWordViewer__title', name));
		header.appendChild(download);
		header.appendChild(close);

		var status = element('p', 'msWordViewer__status', text.loading);
		status.setAttribute('role', 'status');

		var frame = element('iframe', 'msWordViewer__frame');
		frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
		frame.title = text.previewOf.replace('%s', name);
		frame.hidden = true;

		dialog.appendChild(header);
		dialog.appendChild(element('p', 'msWordViewer__notice', text.notice));
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

		Promise.all([fetchFile(url), loadMammoth()]).then(function (results) {
			return results[1].convertToHtml({arrayBuffer: results[0]});
		}).then(function (result) {
			frame.srcdoc = documentHtml(prepareLinks(result.value));
			frame.hidden = false;
			status.hidden = true;
		}).catch(function (error) {
			status.textContent = error && error.notDocx ? text.notDocx : text.error;
			status.classList.add('msWordViewer__status--error');
			if (window.console) {
				console.warn('MS Word Viewer:', error);
			}
		});
	}

	function start() {
		scan(document.body);
		new MutationObserver(function (mutations) {
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
