/**
 * plugins/generic/documentPreview/js/renderers/image.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * Renderer for images in the formats browsers show: PNG, JPEG, GIF, WebP, AVIF,
 * BMP and SVG. No library. The format is taken from the file's first bytes (not
 * from its name); the image is checked by decoding it, and shown as a data: URL
 * in the sandboxed preview. An SVG image is shown as an image (in an img element),
 * so scripts in it don't run and it can't load anything.
 *
 * The image fits the dialog; a click (or Space on the focused image) shows it at
 * its full size and back. That works without scripts, which the preview doesn't run.
 *
 * Also a CommonJS module for the tests in dev/test (detectType, toHtml).
 */
(function () {
	'use strict';

	function startsWith(bytes, signature, offset) {
		offset = offset || 0;
		if (bytes.length < offset + signature.length) {
			return false;
		}
		for (var i = 0; i < signature.length; i++) {
			var expected = typeof signature === 'string' ? signature.charCodeAt(i) : signature[i];
			if (bytes[offset + i] !== expected) {
				return false;
			}
		}
		return true;
	}

	/**
	 * AVIF: an ISO base media file ("ftyp" box) whose major or one of whose
	 * compatible brands is "avif" or "avis".
	 */
	function isAvif(bytes) {
		if (!startsWith(bytes, 'ftyp', 4)) {
			return false;
		}
		var size = Math.min(((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0, bytes.length);
		for (var i = 8; i + 4 <= size; i += 4) {
			if (i === 12) {
				continue; // minor version
			}
			if (startsWith(bytes, 'avif', i) || startsWith(bytes, 'avis', i)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * SVG: an XML text whose root element is svg (after an optional byte order mark,
	 * XML declaration, comments and doctype).
	 */
	function isSvg(bytes) {
		var head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).replace(/^﻿/, '');
		var rest = head.replace(/^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>)\s*)*/i, '');
		return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/.test(rest);
	}

	/**
	 * The image's media type from the file's first bytes, or null.
	 */
	function detectType(buffer) {
		var bytes = new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength));
		if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
			return 'image/png';
		}
		if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
			return 'image/jpeg';
		}
		if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')) {
			return 'image/gif';
		}
		if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) {
			return 'image/webp';
		}
		if (isAvif(bytes)) {
			return 'image/avif';
		}
		if (startsWith(bytes, 'BM') && bytes.length >= 14) {
			return 'image/bmp';
		}
		if (isSvg(bytes)) {
			return 'image/svg+xml';
		}
		return null;
	}

	function escapeAttribute(value) {
		return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	}

	/**
	 * The preview's HTML for the image at dataUrl. The checkbox (visually hidden,
	 * but focusable) switches between "fit" and "full size".
	 */
	function toHtml(dataUrl, name) {
		return '<style>' +
			'body{max-width:none;margin:0;padding:1rem;background:#e8e8e8;text-align:center}' +
			'.zoom{position:absolute;opacity:0;width:1px;height:1px}' +
			'label{display:inline-block;cursor:zoom-in}' +
			'img{display:block;max-width:100%;max-height:calc(100vh - 2rem);margin:0 auto;' +
			'background:#fff repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}' +
			'.zoom:checked+label{cursor:zoom-out}' +
			'.zoom:checked+label img{max-width:none;max-height:none}' +
			'.zoom:focus-visible+label img{outline:2px solid #006798;outline-offset:2px}' +
			'</style>' +
			'<input type="checkbox" class="zoom" id="zoom">' +
			'<label for="zoom"><img src="' + escapeAttribute(dataUrl) + '" alt="' + escapeAttribute(name || '') + '"></label>';
	}

	function readAsDataUrl(buffer, type) {
		return new Promise(function (resolve, reject) {
			var reader = new FileReader();
			reader.onload = function () {
				resolve(reader.result);
			};
			reader.onerror = function () {
				reject(reader.error);
			};
			reader.readAsDataURL(new Blob([buffer], {type: type}));
		});
	}

	/**
	 * Resolves if the browser can show the image, so that a broken or unsupported
	 * file gets the "please download" message instead of a broken image.
	 */
	function decode(dataUrl) {
		var img = new Image();
		img.src = dataUrl;
		if (img.decode) {
			return img.decode();
		}
		return new Promise(function (resolve, reject) {
			img.onload = resolve;
			img.onerror = reject;
		});
	}

	function render(buffer, options, file) {
		var api = window.documentPreview;
		var type = detectType(buffer);
		if (!type) {
			return Promise.reject(api.unsupported('not an image in a supported format'));
		}
		return readAsDataUrl(buffer, type).then(function (dataUrl) {
			return decode(dataUrl).then(function () {
				return toHtml(dataUrl, file && file.name);
			}, function () {
				throw api.unsupported('the browser cannot show this image');
			});
		});
	}

	var image = {detectType: detectType, toHtml: toHtml, render: render};

	if (typeof module === 'object' && module && module.exports) {
		module.exports = image;
	}
	if (typeof window !== 'undefined' && window.documentPreview) {
		window.documentPreview.register('image', {render: render});
	}
})();
