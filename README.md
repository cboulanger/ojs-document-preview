# Document Preview for OJS 3.5

A lightweight OJS plugin that lets editors, reviewers and authors **read submitted documents in the browser** instead of downloading them. Supported formats: **DOCX**, converted with [mammoth.js](https://github.com/mwilliamson/mammoth.js), and **ODT** (OpenDocument text, as written by LibreOffice; also the single-file `.fodt`), converted by the plugin's own code. Further formats can be added as renderers (see [Renderers](#renderers)).

The specification is in [issue #1](https://github.com/cboulanger/ojs-document-preview/issues/1), the ODT renderer's in [issue #2](https://github.com/cboulanger/ojs-document-preview/issues/2). The plugin follows the patterns of [Editor Assignments](https://github.com/cboulanger/ojs-editor-assignments) and [Dossier Manager](https://github.com/cboulanger/ojs-dossier-manager).

## What it does

On the backend pages, a **Preview** button (an eye icon, labelled for screen readers) appears before the file download links of documents in a supported format. It sits before the name so that it stays visible when OJS truncates long file names. This covers the workflow's file lists, discussion attachments, the reviewer's files and the file selection dialogs. It works with OJS's newer (Vue) file lists and with the older grids.

Which files get the button:

- files whose name ends in an extension a renderer reads (`.docx`, `.odt`, `.fodt`);
- files whose name has no extension (OJS allows any name, also an empty one, and files from older OJS versions often have one): the plugin asks OJS's download link for the file's media type with one `HEAD` request per file, at most three at a time, and uses that;
- files with another extension (`.pdf`, `.doc`, …) get no button and cause no request.

The button opens a dialog with:

- the document as simple HTML: headings, paragraphs, bold/italic, lists, tables, links, images, footnotes and endnotes;
- a note that this is a simplified preview (no page layout, page breaks, headers, footers or comments);
- **Download** (the original file) and **Close** (or Escape, or a click outside the dialog).

How it works:

- The file is loaded through the same OJS download link as the file name. OJS checks access exactly as it does for a download, so anyone who can see the button can only preview files they could download anyway.
- The conversion happens in the browser. Nothing is converted, cached or stored on the server, and the plugin has no database tables or settings.
- The result is shown in a sandboxed iframe: scripts in the document can't run, the document has no access to OJS, and it can't load anything from outside, so opening a file sends no data to third parties. Links in the document open in a new tab.
- mammoth.js (about 400 KB, 100 KB compressed) is included in the plugin, not loaded from a CDN, and it is only loaded when someone opens their first DOCX preview.
- ODT needs no library: the renderer (about 25 KB) reads the zip archive with the browser's built-in decompression and converts the XML itself. ODT documents get the same simple HTML as DOCX; tracked changes are shown as accepted.
- A file that a renderer can't read (e.g. a file in the older `.doc` format renamed to `.docx`, or a password-protected ODT file) gets a message saying to download it instead.
- The preview doesn't show the document's metadata (such as the author stored in the file's properties), comments or tracked changes. That is useful for anonymous review, but it doesn't replace removing that information from the file.

English and German.

## Installation

Requirements: OJS 3.5, PHP 8.2 or later.

```sh
cd /path/to/ojs/plugins/generic
git clone https://github.com/cboulanger/ojs-document-preview.git documentPreview   # the folder name matters
cd /path/to/ojs
php lib/pkp/tools/installPluginVersion.php plugins/generic/documentPreview/version.xml
```

Then enable *Document Preview* under *Website Settings › Plugins › Generic Plugins*.

## Files

| Path | Contents |
| --- | --- |
| `DocumentPreviewPlugin.php` | The renderer registry; adds the scripts, the styles and the texts to the backend pages |
| `js/documentPreview.js` | Core: finds the download links, adds the buttons, shows the preview; registration API for renderers |
| `js/renderers/docx.js` | DOCX renderer |
| `js/renderers/odt.js` | ODT renderer (zip reader and converter, no library) |
| `css/documentPreview.css` | Button and dialog |
| `js/lib/mammoth.browser.min.js` | mammoth.js 1.13.0 ([BSD 2-Clause](js/lib/mammoth.LICENSE)) |

To update mammoth.js: `npm pack mammoth@<version>`, copy `package/mammoth.browser.min.js` and `package/LICENSE` to `js/lib/` (the license as `mammoth.LICENSE`), and update the version above.

## Renderers

A renderer converts one or more formats to HTML in the browser. It has two parts.

**Registration in PHP**, in `DocumentPreviewPlugin::getRenderers()`, or from another plugin with the hook `DocumentPreview::renderers`:

```php
Hook::add('DocumentPreview::renderers', function (string $hookName, array $args) {
    $renderers = &$args[0];
    $renderers['rtf'] = [
        'script' => $myPluginUrl . '/js/rtf.js',      // registers the renderer in the browser
        'extensions' => ['rtf'],                      // file name extensions, without the dot
        'mimeTypes' => ['application/rtf', 'text/rtf'], // for names without extension
        'options' => ['libraryUrl' => $myPluginUrl . '/js/lib/some-library.js'], // passed to render()
    ];
    return false;
});
```

**The script**, which registers the renderer under the same id:

```js
documentPreview.register('rtf', {
    // buffer: the file as an ArrayBuffer; options: from the PHP registration.
    // Returns (a promise of) the document's body as HTML.
    render: function (buffer, options) {
        return documentPreview.loadScript(options.libraryUrl).then(function () {
            if (!looksLikeRtf(buffer)) {
                throw documentPreview.unsupported();  // "can't be shown, please download"
            }
            return convert(buffer);
        });
    }
});
```

The core takes care of finding the files, the button, loading the file, the dialog and the sandboxed display. `loadScript()` loads a library once, on first use. The HTML may contain images as `data:` URLs; external resources are blocked.

## Tests

The ODT renderer has tests (Node 20 or later): `cd dev && npm install && npm test`. To check it in a browser, outside OJS: run `python3 -m http.server` in the plugin folder and open `http://localhost:8000/dev/test/odt.html` (with `?all` it renders all samples in `dev/test/samples/`). The samples were written with pandoc ([`sample.md`](dev/test/samples/sample.md)) and converted with LibreOffice.

## Releases

The release package contains only what OJS needs (a rule of the PKP Plugin Gallery). What is left out is marked `export-ignore` in [`.gitattributes`](.gitattributes): `dev/` and the repository files.

1. Set `<release>` (four numbers) and `<date>` in `version.xml` and commit.
2. Optional: check the package locally with `dev/package.sh` (writes `dist/`). It fails if the package lacks a runtime file or contains development files.
3. Push an annotated tag matching the version (`0.1.0.0` → `v0.1.0`, `0.1.0.2` → `v0.1.0-2`). Its first line becomes the release description in the gallery:

   ```sh
   git tag -a v0.1.0 -m "What changed, in one line" && git push origin v0.1.0
   ```

4. The [Release workflow](.github/workflows/release.yml) runs the checks ([CI](.github/workflows/ci.yml): PHP and JavaScript syntax, locale keys, package), builds the package and creates a **draft** release with `documentPreview-v0.1.0.tar.gz`, its `.md5`, `gallery-release.xml` and `gallery-plugin.xml`. Drafts are only visible to the repository's maintainers: download the package with `gh release download v0.1.0 -p '*.tar.gz'`, test it, then publish the draft on GitHub.
5. Plugin Gallery: open a pull request on [pkp/plugin-gallery](https://github.com/pkp/plugin-gallery) that adds `gallery-release.xml` to the plugin's entry in `plugins.xml` (the first time: `gallery-plugin.xml`, the whole entry). Disclose AI-assisted work in the pull request. A package in the gallery must never change (its md5 is checked), so fixes need a new version.

The gallery entry's texts are in [`dev/gallery/plugin.xml`](dev/gallery/plugin.xml) and [`dev/gallery/description.html`](dev/gallery/description.html).

## License

GNU General Public License v3. See [LICENSE](LICENSE). mammoth.js is licensed under the BSD 2-Clause License, see [js/lib/mammoth.LICENSE](js/lib/mammoth.LICENSE).
