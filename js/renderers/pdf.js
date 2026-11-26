/**
 * plugins/generic/documentPreview/js/renderers/pdf.js
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * Renderer for PDF files, with the PDF.js viewer that comes with OJS's "PDF.js PDF
 * Viewer" plugin (plugins/generic/pdfJsViewer). This plugin ships no PDF code of its
 * own: the PHP side registers this renderer only if that plugin is installed, and
 * passes the URL of its viewer page (options.viewerUrl).
 *
 * The viewer loads the file itself, through the same download link (it only accepts
 * files from its own server). It is configured for the preview when it starts (the
 * viewer announces itself to the page that contains it with the event
 * "webviewerloaded"): the OJS user's language, links in the PDF open in a new tab,
 * no JavaScript in the PDF, no entries in the browser's history, and no stored
 * viewer preferences overriding these settings.
 */
(function () {
	'use strict';

	var api = window.documentPreview;
	if (!api) {
		return;
	}
	var LINK_TARGET_BLANK = 2;
	var options = {};

	api.register('pdf', {
		page: function (url, rendererOptions) {
			options = rendererOptions;
			return rendererOptions.viewerUrl + '?file=' + encodeURIComponent(url);
		}
	});

	document.addEventListener('webviewerloaded', function (e) {
		var source = e.detail && e.detail.source;
		var frame;
		try {
			frame = source && source.frameElement;
		} catch (error) {
			return;
		}
		// Only the viewers in the preview, not one that another plugin embeds
		if (!frame || !frame.classList.contains('documentPreview__frame') || !source.PDFViewerApplicationOptions) {
			return;
		}
		var viewerOptions = source.PDFViewerApplicationOptions;
		viewerOptions.set('disablePreferences', true);
		viewerOptions.set('externalLinkTarget', LINK_TARGET_BLANK);
		viewerOptions.set('enableScripting', false);
		viewerOptions.set('disableHistory', true);
		if (options.locale) {
			viewerOptions.set('localeProperties', {lang: options.locale});
		}
	});
})();
