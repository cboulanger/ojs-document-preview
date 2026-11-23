# MS Word Viewer for OJS 3.5

A lightweight OJS plugin that lets editors, reviewers and authors **read submitted Word files (.docx) in the browser** instead of downloading them. The conversion uses [mammoth.js](https://github.com/mwilliamson/mammoth.js).

The specification is in [issue #1](https://github.com/cboulanger/ojs-ms-word-viewer/issues/1). The plugin follows the patterns of [Editor Assignments](https://github.com/cboulanger/ojs-editor-assignments) and [Dossier Manager](https://github.com/cboulanger/ojs-dossier-manager).

## What it does

On the backend pages, a **Preview** button appears next to every file download link whose file name ends in `.docx`. This covers the workflow's file lists, discussion attachments, the reviewer's files and the file selection dialogs. It works with OJS's newer (Vue) file lists and with the older grids.

The button opens a dialog with:

- the document as simple HTML: headings, paragraphs, bold/italic, lists, tables, links, images, footnotes and endnotes;
- a note that this is a simplified preview (no page layout, page breaks, headers, footers or comments);
- **Download** (the original file) and **Close** (or Escape, or a click outside the dialog).

How it works:

- The file is loaded through the same OJS download link as the file name. OJS checks access exactly as it does for a download, so anyone who can see the button can only preview files they could download anyway.
- The conversion happens in the browser. Nothing is converted, cached or stored on the server, and the plugin has no database tables or settings.
- The result is shown in a sandboxed iframe: scripts in the document can't run, the document has no access to OJS, and it can't load anything from outside, so opening a file sends no data to third parties. Links in the document open in a new tab.
- mammoth.js (about 400 KB, 100 KB compressed) is included in the plugin, not loaded from a CDN, and it is only loaded when someone opens their first preview.
- Old Word files (`.doc`) and files that aren't really `.docx` get no button, or an error message saying to download the file instead.
- The preview doesn't show the document's metadata (such as the author stored in the file's properties), comments or tracked changes. That is useful for anonymous review, but it doesn't replace removing that information from the file.

English and German.

## Installation

Requirements: OJS 3.5, PHP 8.2 or later.

```sh
cd /path/to/ojs/plugins/generic
git clone https://github.com/cboulanger/ojs-ms-word-viewer.git msWordViewer   # the folder name matters
cd /path/to/ojs
php lib/pkp/tools/installPluginVersion.php plugins/generic/msWordViewer/version.xml
```

Then enable *MS Word Viewer* under *Website Settings › Plugins › Generic Plugins*.

## Files

| Path | Contents |
| --- | --- |
| `MsWordViewerPlugin.php` | Adds the script, the styles and the texts to the backend pages |
| `js/msWordViewer.js` | Finds the download links, adds the buttons, shows the preview |
| `css/msWordViewer.css` | Button and dialog |
| `js/lib/mammoth.browser.min.js` | mammoth.js 1.13.0 ([BSD 2-Clause](js/lib/mammoth.LICENSE)) |

To update mammoth.js: `npm pack mammoth@<version>`, copy `package/mammoth.browser.min.js` and `package/LICENSE` to `js/lib/` (the license as `mammoth.LICENSE`), and update the version above.

## License

GNU General Public License v3. See [LICENSE](LICENSE). mammoth.js is licensed under the BSD 2-Clause License, see [js/lib/mammoth.LICENSE](js/lib/mammoth.LICENSE).
