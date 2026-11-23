/**
 * plugins/generic/documentPreview/js/renderers/docx.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * Renderer for DOCX documents (Office Open XML), with mammoth.js. mammoth.js is
 * loaded on the first preview only (options.mammothUrl).
 */
(function () {
	'use strict';

	var api = window.documentPreview;
	if (!api) {
		return;
	}

	api.register('docx', {
		render: function (buffer, options) {
			// A DOCX file is a zip archive ("PK"); anything else (a file in the older
			// .doc format renamed, an error page) can't be converted.
			var bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
			if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
				return Promise.reject(api.unsupported('not a DOCX file'));
			}
			return api.loadScript(options.mammothUrl).then(function () {
				if (!window.mammoth) {
					throw new Error('mammoth.js not available');
				}
				return window.mammoth.convertToHtml({arrayBuffer: buffer});
			}).then(function (result) {
				return result.value;
			});
		}
	});
})();
