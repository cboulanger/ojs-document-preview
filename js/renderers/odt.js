/**
 * plugins/generic/documentPreview/js/renderers/odt.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * Renderer for OpenDocument text: .odt (a zip archive) and .fodt (the same as a
 * single XML file). No library: the archive is read with the browser's
 * DecompressionStream, the XML with DOMParser, and the document is converted to
 * the same simple HTML as the DOCX renderer (headings, paragraphs, formatting,
 * lists, tables, links, images, footnotes and endnotes). Comments, tracked
 * changes (shown as accepted) and metadata are left out.
 *
 * Also a CommonJS module for the tests in dev/test (unzip, toHtml, render).
 */
(function () {
	'use strict';

	var NS = {
		'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
		'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
		'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
		'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
		'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
		'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
		'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
		'http://www.w3.org/1999/xlink': 'xlink'
	};
	var URI = {};
	Object.keys(NS).forEach(function (uri) {
		URI[NS[uri]] = uri;
	});
	var ODT_TYPE = 'application/vnd.oasis.opendocument.text';
	var FORMATS = ['strong', 'em', 'u', 's', 'sup', 'sub'];

	function unsupported(message) {
		var error = new Error(message || 'unsupported file');
		error.unsupported = true;
		return error;
	}

	// --- Zip ----------------------------------------------------------------------

	function inflate(bytes) {
		if (typeof DecompressionStream === 'undefined') {
			return Promise.reject(unsupported('DecompressionStream not available'));
		}
		var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
		return new Response(stream).arrayBuffer().then(function (buffer) {
			return new Uint8Array(buffer);
		}, function () {
			throw unsupported('damaged zip entry');
		});
	}

	/**
	 * The entries of a zip archive, by name, as functions that return a promise of
	 * the entry's bytes. Sizes and offsets come from the central directory, so
	 * entries with a data descriptor work too. No ZIP64 (documents over 4 GB).
	 */
	function unzip(buffer) {
		return Promise.resolve().then(function () {
			var view = new DataView(buffer);
			var bytes = new Uint8Array(buffer);
			var eocd = -1;
			for (var i = buffer.byteLength - 22; i >= 0 && i >= buffer.byteLength - 65557; i--) {
				if (view.getUint32(i, true) === 0x06054b50) {
					eocd = i;
					break;
				}
			}
			if (eocd < 0) {
				throw unsupported('not a zip archive');
			}
			var count = view.getUint16(eocd + 10, true);
			var pos = view.getUint32(eocd + 16, true);
			var names = new TextDecoder('utf-8');
			var files = {};
			for (var n = 0; n < count; n++) {
				if (pos + 46 > buffer.byteLength || view.getUint32(pos, true) !== 0x02014b50) {
					throw unsupported('damaged zip directory');
				}
				var nameLength = view.getUint16(pos + 28, true);
				var name = names.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
				files[name] = entry(view, {
					flags: view.getUint16(pos + 8, true),
					method: view.getUint16(pos + 10, true),
					size: view.getUint32(pos + 20, true),
					offset: view.getUint32(pos + 42, true)
				});
				pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
			}
			return files;
		});
	}

	function entry(view, info) {
		return function () {
			return Promise.resolve().then(function () {
				if (info.flags & 1) {
					throw unsupported('encrypted zip entry');
				}
				if (info.offset + 30 > view.byteLength || view.getUint32(info.offset, true) !== 0x04034b50) {
					throw unsupported('damaged zip entry');
				}
				var start = info.offset + 30 + view.getUint16(info.offset + 26, true) + view.getUint16(info.offset + 28, true);
				var data = new Uint8Array(view.buffer, start, Math.min(info.size, view.byteLength - start));
				if (info.method === 0) {
					return data;
				}
				if (info.method === 8) {
					return inflate(data);
				}
				throw unsupported('zip compression method ' + info.method);
			});
		};
	}

	// --- XML helpers --------------------------------------------------------------

	function parseXml(source) {
		var doc;
		try {
			doc = new DOMParser().parseFromString(source, 'application/xml');
		} catch (e) {
			throw unsupported('invalid XML');
		}
		if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) {
			throw unsupported('invalid XML');
		}
		return doc;
	}

	/** "prefix:localName" with the standard prefixes, whatever the document uses */
	function qname(node) {
		return (NS[node.namespaceURI] || '?') + ':' + node.localName;
	}

	function attr(node, name) {
		var parts = name.split(':');
		return node.getAttributeNS(URI[parts[0]], parts[1]) || '';
	}

	function elements(node) {
		var result = [];
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 1) {
				result.push(child);
			}
		}
		return result;
	}

	function find(node, name) {
		return elements(node).filter(function (child) {
			return qname(child) === name;
		});
	}

	function escapeText(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function escapeAttr(s) {
		return escapeText(s).replace(/"/g, '&quot;');
	}

	// --- Images -------------------------------------------------------------------

	function base64(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(s);
	}

	/** Media type of an image the browser can show, from its first bytes; or '' */
	function imageType(bytes) {
		var b = function (i) { return bytes[i]; };
		var ascii = function (from, to) { return String.fromCharCode.apply(null, bytes.subarray(from, to)); };
		if (b(0) === 0x89 && ascii(1, 4) === 'PNG') { return 'image/png'; }
		if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) { return 'image/jpeg'; }
		if (ascii(0, 4) === 'GIF8') { return 'image/gif'; }
		if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') { return 'image/webp'; }
		if (ascii(0, 2) === 'BM') { return 'image/bmp'; }
		if (/<svg[\s>]/.test(new TextDecoder('utf-8').decode(bytes.subarray(0, 1024)))) { return 'image/svg+xml'; }
		return '';
	}

	function dataUrl(bytes) {
		var type = imageType(bytes);
		return type ? 'data:' + type + ';base64,' + base64(bytes) : '';
	}

	/** Image embedded as base64 (flat ODT) */
	function binaryDataUrl(b64) {
		b64 = b64.replace(/\s+/g, '');
		var head;
		try {
			head = atob(b64.slice(0, 1024));
		} catch (e) {
			return '';
		}
		var bytes = new Uint8Array(head.length);
		for (var i = 0; i < head.length; i++) {
			bytes[i] = head.charCodeAt(i);
		}
		var type = imageType(bytes);
		return type ? 'data:' + type + ';base64,' + b64 : '';
	}

	function imagePath(href) {
		return href.replace(/^\.\//, '');
	}

	// --- Styles -------------------------------------------------------------------

	function textFormat(props) {
		var format = {};
		if (!props) {
			return format;
		}
		var weight = attr(props, 'fo:font-weight');
		if (weight) {
			format.strong = weight === 'bold' || parseInt(weight, 10) >= 600;
		}
		var style = attr(props, 'fo:font-style');
		if (style) {
			format.em = style === 'italic' || style === 'oblique';
		}
		var underline = attr(props, 'style:text-underline-style');
		if (underline) {
			format.u = underline !== 'none';
		}
		var strike = attr(props, 'style:text-line-through-style');
		if (strike) {
			format.s = strike !== 'none';
		}
		var position = attr(props, 'style:text-position').split(/\s+/)[0];
		if (position) {
			var offset = position === 'super' ? 1 : position === 'sub' ? -1 : parseFloat(position) || 0;
			format.sup = offset > 0;
			format.sub = offset < 0;
		}
		return format;
	}

	/** Styles by family and name, and list styles by name, from both documents */
	function collectStyles(docs) {
		var styles = {};
		var lists = {};
		docs.forEach(function (doc) {
			['styles', 'automatic-styles'].forEach(function (container) {
				var nodes = doc.getElementsByTagNameNS(URI.office, container);
				for (var i = 0; i < nodes.length; i++) {
					elements(nodes[i]).forEach(function (node) {
						var name = attr(node, 'style:name');
						if (qname(node) === 'style:style') {
							var level = parseInt(attr(node, 'style:default-outline-level'), 10);
							var heading = /^Heading_20_(\d+)$/.exec(name);
							styles[attr(node, 'style:family') + '/' + name] = {
								name: name,
								automatic: container === 'automatic-styles',
								parent: attr(node, 'style:parent-style-name'),
								format: textFormat(find(node, 'style:text-properties')[0]),
								outline: level > 0 ? level : heading ? parseInt(heading[1], 10) : 0
							};
						} else if (qname(node) === 'text:list-style') {
							var levels = {};
							elements(node).forEach(function (levelStyle) {
								levels[attr(levelStyle, 'text:level')] = qname(levelStyle) === 'text:list-level-style-number' ? 'ol' : 'ul';
							});
							lists[name] = levels;
						}
					});
				}
			});
		});
		return {styles: styles, lists: lists};
	}

	/** The style and its ancestors, the style itself first */
	function styleChain(state, family, name) {
		var chain = [];
		while (name && chain.length < 20) {
			var style = state.styles[family + '/' + name];
			if (!style) {
				break;
			}
			chain.push(style);
			name = style.parent;
		}
		return chain;
	}

	function resolvedFormat(state, family, name) {
		var format = {};
		styleChain(state, family, name).reverse().forEach(function (style) {
			Object.keys(style.format).forEach(function (key) {
				format[key] = style.format[key];
			});
		});
		return format;
	}

	function outlineLevel(state, name) {
		var chain = styleChain(state, 'paragraph', name);
		// "Title" as in mammoth's default style map: the paragraph's own named style
		// (after any automatic style for direct formatting), not styles based on it
		var named = chain.filter(function (style) { return !style.automatic; })[0];
		if (named && named.name === 'Title') {
			return 1;
		}
		for (var i = 0; i < chain.length; i++) {
			if (chain[i].outline) {
				return chain[i].outline;
			}
		}
		return 0;
	}

	/** Wraps html in the formats that are on in format but not in context */
	function formatted(html, format, context) {
		if (!html) {
			return html;
		}
		var open = FORMATS.filter(function (tag) {
			return format[tag] && !context[tag];
		});
		return open.map(function (tag) { return '<' + tag + '>'; }).join('') + html +
			open.reverse().map(function (tag) { return '</' + tag + '>'; }).join('');
	}

	function merge(context, format) {
		var result = {};
		FORMATS.forEach(function (tag) {
			result[tag] = tag in format ? format[tag] : !!context[tag];
		});
		return result;
	}

	// --- Conversion: inline -------------------------------------------------------

	var DROPPED = {
		'office:annotation': 1, 'office:annotation-end': 1,
		'text:change': 1, 'text:change-start': 1, 'text:change-end': 1, 'text:tracked-changes': 1,
		'text:bookmark': 1, 'text:bookmark-start': 1, 'text:bookmark-end': 1,
		'text:reference-mark': 1, 'text:reference-mark-start': 1, 'text:reference-mark-end': 1,
		'text:soft-page-break': 1, 'text:sequence-decls': 1, 'text:variable-decls': 1,
		'text:user-field-decls': 1, 'text:dde-connection-decls': 1, 'office:forms': 1,
		'table:table-column': 1, 'table:table-columns': 1, 'table:table-column-group': 1
	};

	function safeHref(href) {
		return /^(https?:|mailto:|#)/i.test(href) ? href : '';
	}

	function inline(state, node, context) {
		var html = '';
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3 || child.nodeType === 4) {
				html += escapeText(child.nodeValue.replace(/[ \t\r\n]+/g, ' '));
			} else if (child.nodeType === 1) {
				html += inlineElement(state, child, context);
			}
		}
		return html;
	}

	function inlineElement(state, node, context) {
		var name = qname(node);
		if (DROPPED[name] || /^text:.*-source$/.test(name)) {
			return '';
		}
		switch (name) {
			case 'text:span':
				var format = merge(context, resolvedFormat(state, 'text', attr(node, 'text:style-name')));
				return formatted(inline(state, node, format), format, context);
			case 'text:a':
				var content = inline(state, node, context);
				var href = safeHref(attr(node, 'xlink:href'));
				return href ? '<a href="' + escapeAttr(href) + '">' + content + '</a>' : content;
			case 'text:s':
				return new Array((parseInt(attr(node, 'text:c'), 10) || 1) + 1).join(' ');
			case 'text:tab':
				return ' ';
			case 'text:line-break':
				return '<br>';
			case 'text:note':
				return note(state, node);
			case 'text:number':
				return inline(state, node, context) + ' ';
			case 'draw:frame':
				return frame(state, node, context);
			case 'text:p':
			case 'text:h':
			case 'text:list':
			case 'text:list-item':
			case 'text:list-header':
			case 'table:table':
				// Block content where only inline content can go (e.g. in a shape)
				return textBox(state, node, context);
			default:
				return inline(state, node, context);
		}
	}

	function frame(state, node, context) {
		var images = find(node, 'draw:image');
		for (var i = 0; i < images.length; i++) {
			var data = find(images[i], 'office:binary-data')[0];
			var src = data ? binaryDataUrl(data.textContent) : state.images[imagePath(attr(images[i], 'xlink:href'))];
			if (src) {
				var title = find(node, 'svg:title')[0] || find(node, 'svg:desc')[0];
				return '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(title ? title.textContent.trim() : '') + '">';
			}
		}
		var box = find(node, 'draw:text-box')[0];
		return box ? textBox(state, box, context) : '';
	}

	/** The paragraphs in a text frame (e.g. an image with a caption), as lines */
	function textBox(state, node, context) {
		var lines = [];
		var collect = function (parent) {
			elements(parent).forEach(function (child) {
				var name = qname(child);
				if (name === 'text:p' || name === 'text:h') {
					lines.push(inline(state, child, context));
				} else if (!DROPPED[name]) {
					collect(child);
				}
			});
		};
		var name = qname(node);
		if (name === 'text:p' || name === 'text:h') {
			lines.push(inline(state, node, context));
		} else {
			collect(node);
		}
		return lines.filter(function (line) { return line.trim(); }).join('<br>');
	}

	function note(state, node) {
		var kind = attr(node, 'text:note-class') === 'endnote' ? 'endnote' : 'footnote';
		var number = state.notes[kind].length + 1;
		var id = kind + '-' + number;
		var back = ' <a href="#' + kind + '-ref-' + number + '">↑</a>';
		var body = find(node, 'text:note-body')[0];
		var html = body ? blocks(state, body) : '';
		html = /<\/p>$/.test(html) ? html.replace(/<\/p>$/, back + '</p>') : html + '<p>' + back.trim() + '</p>';
		state.notes[kind].push('<li id="' + id + '">' + html + '</li>');
		return '<sup><a href="#' + id + '" id="' + kind + '-ref-' + number + '">[' + number + ']</a></sup>';
	}

	// --- Conversion: blocks -------------------------------------------------------

	function paragraph(state, node, wrap) {
		var styleName = attr(node, 'text:style-name');
		var format = merge({}, resolvedFormat(state, 'paragraph', styleName));
		var level = qname(node) === 'text:h' ? parseInt(attr(node, 'text:outline-level'), 10) || 1 : outlineLevel(state, styleName);
		if (level) {
			// Headings: their own bold etc. is implied
			var heading = inline(state, node, format).trim();
			return heading ? '<h' + Math.min(level, 6) + '>' + heading + '</h' + Math.min(level, 6) + '>' : '';
		}
		var html = formatted(inline(state, node, format).trim(), format, {});
		return html && wrap !== false ? '<p>' + html + '</p>' : html;
	}

	function containsHeading(node) {
		return elements(node).some(function (child) {
			var name = qname(child);
			return name === 'text:h' || ((name === 'text:list' || name === 'text:list-item' || name === 'text:list-header') && containsHeading(child));
		});
	}

	function list(state, node, styleName, level) {
		styleName = attr(node, 'text:style-name') || styleName;
		var items = elements(node).filter(function (child) {
			return qname(child) === 'text:list-item' || qname(child) === 'text:list-header';
		});
		if (containsHeading(node)) {
			// Numbered headings: show them as headings, not as a list
			return items.map(function (item) { return blocks(state, item, styleName, level + 1); }).join('');
		}
		var tag = (state.lists[styleName] || {})[level] || 'ul';
		var html = items.map(function (item) {
			var paragraphs = find(item, 'text:p');
			var content = paragraphs.length === 1
				? elements(item).map(function (child) {
					return child === paragraphs[0] ? paragraph(state, child, false) : block(state, child, styleName, level + 1);
				}).join('')
				: blocks(state, item, styleName, level + 1);
			return '<li>' + content + '</li>';
		}).join('');
		return html ? '<' + tag + '>' + html + '</' + tag + '>' : '';
	}

	function table(state, node) {
		var head = '';
		var body = '';
		var rows = function (parent, cellTag) {
			var html = '';
			elements(parent).forEach(function (child) {
				var name = qname(child);
				if (name === 'table:table-row') {
					html += '<tr>' + elements(child).filter(function (cell) {
						return qname(cell) === 'table:table-cell';
					}).map(function (cell) {
						var colspan = parseInt(attr(cell, 'table:number-columns-spanned'), 10) || 1;
						var rowspan = parseInt(attr(cell, 'table:number-rows-spanned'), 10) || 1;
						return '<' + cellTag + (colspan > 1 ? ' colspan="' + colspan + '"' : '') +
							(rowspan > 1 ? ' rowspan="' + rowspan + '"' : '') + '>' + blocks(state, cell) + '</' + cellTag + '>';
					}).join('') + '</tr>';
				} else if (name === 'table:table-header-rows') {
					head += rows(child, 'th');
				} else if (name === 'table:table-rows' || name === 'table:table-row-group') {
					html += rows(child, cellTag);
				}
			});
			return html;
		};
		body = rows(node, 'td');
		return '<table>' + (head ? '<thead>' + head + '</thead>' : '') + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>';
	}

	function block(state, node, listStyle, listLevel) {
		var name = qname(node);
		if (DROPPED[name] || /^text:.*-source$/.test(name)) {
			return '';
		}
		switch (name) {
			case 'text:p':
			case 'text:h':
				return paragraph(state, node);
			case 'text:list':
				return list(state, node, listStyle, listLevel || 1);
			case 'table:table':
				return table(state, node);
			default:
				if (/^draw:/.test(name)) {
					var html = inlineElement(state, node, {});
					return html ? '<p>' + html + '</p>' : '';
				}
				// Sections, tables of contents and other containers: their contents
				return blocks(state, node, listStyle, listLevel);
		}
	}

	/** A list whose items only hold nested lists (LibreOffice's way to continue the nesting of the list before) */
	function isNestingOnly(node) {
		var items = find(node, 'text:list-item');
		return items.length > 0 && items.every(function (item) {
			return elements(item).every(function (child) { return qname(child) === 'text:list'; });
		});
	}

	function blocks(state, node, listStyle, listLevel) {
		var parts = [];
		var lastIsList = false;
		elements(node).forEach(function (child) {
			var isList = qname(child) === 'text:list';
			var previous = parts.length ? parts[parts.length - 1] : '';
			var level = listLevel || 1;
			if (isList && lastIsList && isNestingOnly(child) && /<\/li><\/(ol|ul)>$/.test(previous)) {
				// Into the last item of the list before
				var styleName = attr(child, 'text:style-name') || listStyle;
				var nested = find(child, 'text:list-item').map(function (item) {
					return blocks(state, item, styleName, level + 1);
				}).join('');
				parts[parts.length - 1] = previous.replace(/<\/li><\/(ol|ul)>$/, nested + '</li></$1>');
				return;
			}
			var html = block(state, child, listStyle, listLevel);
			if (!html) {
				return;
			}
			var tag = isList && /^<(ol|ul)>/.exec(html);
			if (tag && lastIsList && (attr(child, 'text:continue-list') || attr(child, 'text:continue-numbering') === 'true') &&
				previous.slice(-5) === '</' + tag[1] + '>') {
				parts[parts.length - 1] = previous.slice(0, -5) + html.slice(4);
			} else {
				parts.push(html);
			}
			lastIsList = isList;
		});
		return parts.join('');
	}

	/**
	 * The HTML of a document. contentXml: content.xml, or the whole flat document;
	 * stylesXml: styles.xml or null (strings or parsed documents); images: data URLs
	 * by path in the archive.
	 */
	function toHtml(contentXml, stylesXml, images) {
		var docs = [contentXml, stylesXml].filter(Boolean).map(function (xml) {
			return typeof xml === 'string' ? parseXml(xml) : xml;
		});
		var collected = collectStyles(docs);
		var state = {styles: collected.styles, lists: collected.lists, images: images || {}, notes: {footnote: [], endnote: []}};
		var text = docs[0].getElementsByTagNameNS(URI.office, 'text')[0];
		if (!text) {
			throw unsupported('not a text document');
		}
		var html = blocks(state, text);
		['footnote', 'endnote'].forEach(function (kind) {
			if (state.notes[kind].length) {
				html += '<ol>' + state.notes[kind].join('') + '</ol>';
			}
		});
		return html;
	}

	// --- Files --------------------------------------------------------------------

	function checkRoot(doc, localName) {
		var root = doc.documentElement;
		if (root.namespaceURI !== URI.office || root.localName !== localName) {
			throw unsupported('not an OpenDocument file');
		}
		return doc;
	}

	function decode(bytes) {
		return new TextDecoder('utf-8').decode(bytes);
	}

	function renderZip(buffer) {
		return unzip(buffer).then(function (files) {
			if (!files['content.xml']) {
				throw unsupported('no content.xml');
			}
			var read = function (name) {
				return files[name] ? files[name]().then(decode) : Promise.resolve(null);
			};
			return Promise.all([read('mimetype'), read('META-INF/manifest.xml')]).then(function (meta) {
				if (meta[0] !== null && meta[0].trim() !== ODT_TYPE) {
					throw unsupported('not an OpenDocument text: ' + meta[0]);
				}
				if (meta[1] && /encryption-data/.test(meta[1])) {
					throw unsupported('encrypted document');
				}
				return Promise.all([read('content.xml'), read('styles.xml')]);
			}).then(function (xml) {
				var content = checkRoot(parseXml(xml[0]), 'document-content');
				var styles = xml[1] ? parseXml(xml[1]) : null;
				var nodes = content.getElementsByTagNameNS(URI.draw, 'image');
				var paths = [];
				for (var i = 0; i < nodes.length; i++) {
					var path = imagePath(attr(nodes[i], 'xlink:href'));
					if (files[path] && paths.indexOf(path) < 0) {
						paths.push(path);
					}
				}
				return Promise.all(paths.map(function (path) {
					return files[path]().then(dataUrl, function () { return ''; });
				})).then(function (urls) {
					var images = {};
					paths.forEach(function (path, n) {
						images[path] = urls[n];
					});
					return toHtml(content, styles, images);
				});
			});
		});
	}

	function renderFlat(buffer) {
		var doc = checkRoot(parseXml(decode(new Uint8Array(buffer))), 'document');
		if (attr(doc.documentElement, 'office:mimetype') !== ODT_TYPE) {
			throw unsupported('not an OpenDocument text');
		}
		return toHtml(doc, null, {});
	}

	function render(buffer) {
		return Promise.resolve().then(function () {
			var head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
			return head[0] === 0x50 && head[1] === 0x4b ? renderZip(buffer) : renderFlat(buffer);
		});
	}

	var odt = {unzip: unzip, toHtml: toHtml, render: render};

	if (typeof module === 'object' && module && module.exports) {
		module.exports = odt;
	}
	if (typeof window !== 'undefined' && window.documentPreview) {
		window.documentPreview.register('odt', {render: render});
	}
})();
