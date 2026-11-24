// Tests for js/renderers/odt.js (run: cd dev && npm test).
// The renderer runs in the browser; here, xmldom stands in for the browser's DOMParser.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {deflateRawSync} from 'node:zlib';
import {DOMParser} from '@xmldom/xmldom';

globalThis.DOMParser = DOMParser;
const require = createRequire(import.meta.url);
const odt = require('../../js/renderers/odt.js');

// --- Helpers ----------------------------------------------------------------

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
	'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
	'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
	'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
	'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
	'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
	'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';

function content(body, autoStyles = '') {
	return `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3">` +
		`<office:automatic-styles>${autoStyles}</office:automatic-styles>` +
		`<office:body><office:text>${body}</office:text></office:body></office:document-content>`;
}

function styles(namedStyles) {
	return `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}>` +
		`<office:styles>${namedStyles}</office:styles></office:document-styles>`;
}

const html = (body, autoStyles, stylesXml = null, images = {}) =>
	odt.toHtml(content(body, autoStyles), stylesXml, images);

/** A zip archive; entries: [name, string|Uint8Array, {store, dataDescriptor}] */
function zip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [name, data, opts = {}] of entries) {
		const raw = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
		const stored = opts.store;
		const body = stored ? raw : deflateRawSync(raw);
		const nameBytes = Buffer.from(name);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(opts.dataDescriptor ? 8 : 0, 6);
		header.writeUInt16LE(stored ? 0 : 8, 8);
		// with a data descriptor, the sizes in the local header are 0
		header.writeUInt32LE(opts.dataDescriptor ? 0 : body.length, 18);
		header.writeUInt32LE(opts.dataDescriptor ? 0 : raw.length, 22);
		header.writeUInt16LE(nameBytes.length, 26);
		const parts = [header, nameBytes, body];
		if (opts.dataDescriptor) {
			const dd = Buffer.alloc(16);
			dd.writeUInt32LE(0x08074b50, 0);
			dd.writeUInt32LE(body.length, 8);
			dd.writeUInt32LE(raw.length, 12);
			parts.push(dd);
		}
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(opts.encrypted ? 1 : 0, 8);
		cd.writeUInt16LE(opts.method ?? (stored ? 0 : 8), 10);
		cd.writeUInt32LE(body.length, 20);
		cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(nameBytes.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, nameBytes);
		local.push(...parts);
		offset += parts.reduce((n, p) => n + p.length, 0);
	}
	const cdBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	const all = Buffer.concat([...local, cdBuf, eocd]);
	return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const MIMETYPE = ['mimetype', 'application/vnd.oasis.opendocument.text', {store: true}];
const manifest = (extra = '') => ['META-INF/manifest.xml',
	'<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
	'<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
	extra + '</manifest:manifest>'];

async function rejectsUnsupported(promise) {
	await assert.rejects(promise, (e) => e.unsupported === true);
}

const text = (s) => new TextEncoder().encode(s).buffer;

// --- Zip --------------------------------------------------------------------

test('zip: reads stored and deflated entries', async () => {
	const files = await odt.unzip(zip([['a.txt', 'hello', {store: true}], ['b.txt', 'wörld '.repeat(50)]]));
	assert.deepEqual(Object.keys(files).sort(), ['a.txt', 'b.txt']);
	assert.equal(new TextDecoder().decode(await files['a.txt']()), 'hello');
	assert.equal(new TextDecoder().decode(await files['b.txt']()), 'wörld '.repeat(50));
});

test('zip: sizes from the central directory (data descriptor)', async () => {
	const files = await odt.unzip(zip([['a.txt', 'abc'.repeat(100), {dataDescriptor: true}]]));
	assert.equal(new TextDecoder().decode(await files['a.txt']()), 'abc'.repeat(100));
});

test('zip: not a zip, unsupported method, encrypted entry', async () => {
	await rejectsUnsupported(odt.unzip(text('just some text')));
	const files = await odt.unzip(zip([['a', 'x', {method: 12}]]));
	await rejectsUnsupported(files.a());
	const enc = await odt.unzip(zip([['a', 'x', {encrypted: true}]]));
	await rejectsUnsupported(enc.a());
});

// --- Blocks -----------------------------------------------------------------

test('paragraphs and headings', () => {
	assert.equal(html('<text:h text:outline-level="2">Title</text:h><text:p>One</text:p><text:p/><text:p> </text:p>'),
		'<h2>Title</h2><p>One</p>');
	assert.equal(html('<text:h text:outline-level="9">Deep</text:h><text:h>None</text:h>'), '<h6>Deep</h6><h1>None</h1>');
});

test('heading by style (text:p with a heading style, also via parent)', () => {
	const s = styles('<style:style style:name="Heading_20_2" style:family="paragraph" style:default-outline-level="2"/>' +
		'<style:style style:name="Heading_20_3" style:family="paragraph"/>');
	const auto = '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Heading_20_2">' +
		'<style:text-properties fo:font-weight="bold"/></style:style>';
	assert.equal(html('<text:p text:style-name="P1">A</text:p><text:p text:style-name="Heading_20_3">B</text:p>', auto, s),
		'<h2>A</h2><h3>B</h3>');
});

test('lists: bullets, numbers, nesting, list style inherited by nested lists', () => {
	const auto = '<text:list-style style:name="L1">' +
		'<text:list-level-style-number text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>';
	const body = '<text:list text:style-name="L1"><text:list-item><text:p>One</text:p>' +
		'<text:list><text:list-item><text:p>Sub</text:p></text:list-item></text:list></text:list-item>' +
		'<text:list-item><text:p>Two</text:p><text:p>More</text:p></text:list-item></text:list>' +
		'<text:list><text:list-item><text:p>Plain</text:p></text:list-item></text:list>';
	assert.equal(html(body, auto),
		'<ol><li>One<ul><li>Sub</li></ul></li><li><p>Two</p><p>More</p></li></ol><ul><li>Plain</li></ul>');
});

test('lists split by LibreOffice (Word import): nesting placeholders and continued lists are joined', () => {
	const auto = '<text:list-style style:name="N"><text:list-level-style-number text:level="1"/></text:list-style>' +
		'<text:list-style style:name="B"><text:list-level-style-bullet text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>';
	const body = '<text:list xml:id="l1" text:style-name="N"><text:list-item><text:p>One</text:p></text:list-item>' +
		'<text:list-item><text:p>Two</text:p></text:list-item></text:list>' +
		'<text:list xml:id="l2" text:style-name="B"><text:list-item><text:list><text:list-item><text:p>a</text:p></text:list-item></text:list></text:list-item></text:list>' +
		'<text:list text:continue-list="l1" text:style-name="N"><text:list-item><text:p>Three</text:p></text:list-item></text:list>' +
		'<text:list text:continue-list="l2" text:style-name="B"><text:list-item><text:p>Bullet</text:p></text:list-item></text:list>';
	assert.equal(html(body, auto), '<ol><li>One</li><li>Two<ul><li>a</li></ul></li><li>Three</li></ol><ul><li>Bullet</li></ul>');
});

test('the Title style is a first-level heading, as in the DOCX preview', () => {
	const s = styles('<style:style style:name="Title" style:family="paragraph"/>' +
		'<style:style style:name="Author" style:family="paragraph" style:parent-style-name="Title"/>');
	// P1: automatic style (direct formatting) on a Title paragraph; Author: a named style based on Title
	const auto = '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Title"/>';
	assert.equal(html('<text:p text:style-name="Title">Paper</text:p><text:p text:style-name="P1">Sub</text:p>' +
		'<text:p text:style-name="Author">Me</text:p>', auto, s), '<h1>Paper</h1><h1>Sub</h1><p>Me</p>');
});

test('numbered headings in a list are shown as headings', () => {
	const body = '<text:list><text:list-item><text:h text:outline-level="1">Intro</text:h>' +
		'<text:list><text:list-item><text:h text:outline-level="2">Part</text:h></text:list-item></text:list>' +
		'</text:list-item></text:list>';
	assert.equal(html(body), '<h1>Intro</h1><h2>Part</h2>');
});

test('tables: header rows, spans, covered cells', () => {
	const body = '<table:table><table:table-column table:number-columns-repeated="2"/>' +
		'<table:table-header-rows><table:table-row><table:table-cell><text:p>H1</text:p></table:table-cell>' +
		'<table:table-cell><text:p>H2</text:p></table:table-cell></table:table-row></table:table-header-rows>' +
		'<table:table-row><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1"><text:p>Wide</text:p></table:table-cell>' +
		'<table:covered-table-cell/></table:table-row>' +
		'<table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>Tall</text:p></table:table-cell><table:table-cell/></table:table-row>' +
		'</table:table>';
	assert.equal(html(body), '<table><thead><tr><th><p>H1</p></th><th><p>H2</p></th></tr></thead>' +
		'<tbody><tr><td colspan="2"><p>Wide</p></td></tr><tr><td rowspan="2"><p>Tall</p></td><td></td></tr></tbody></table>');
});

test('sections and tables of contents: contents shown, source dropped', () => {
	const body = '<text:section><text:p>In section</text:p></text:section>' +
		'<text:table-of-content><text:table-of-content-source><text:index-title-template>X</text:index-title-template></text:table-of-content-source>' +
		'<text:index-body><text:p>Chapter 1</text:p></text:index-body></text:table-of-content>';
	assert.equal(html(body), '<p>In section</p><p>Chapter 1</p>');
});

// --- Inline -----------------------------------------------------------------

test('inline formatting from automatic span styles', () => {
	const auto = '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>' +
		'<style:style style:name="T2" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-line-through-style="solid"/></style:style>' +
		'<style:style style:name="T3" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>' +
		'<style:style style:name="T4" style:family="text"><style:text-properties style:text-position="-33% 58%"/></style:style>' +
		'<style:style style:name="T5" style:family="text"><style:text-properties fo:font-weight="700" style:text-underline-style="none"/></style:style>';
	assert.equal(html('<text:p>a <text:span text:style-name="T1">b</text:span> <text:span text:style-name="T2">c</text:span>' +
		'<text:span text:style-name="T3">d</text:span><text:span text:style-name="T4">e</text:span><text:span text:style-name="T5">f</text:span></text:p>', auto),
	'<p>a <strong><em>b</em></strong> <u><s>c</s></u><sup>d</sup><sub>e</sub><strong>f</strong></p>');
});

test('inherited formatting: paragraph style and named styles in styles.xml', () => {
	const s = styles('<style:style style:name="Emphasis" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>' +
		'<style:style style:name="Quote" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>');
	const auto = '<style:style style:name="T1" style:family="text" style:parent-style-name="Emphasis"/>' +
		'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Quote"/>';
	assert.equal(html('<text:p><text:span text:style-name="T1">x</text:span></text:p><text:p text:style-name="P1">y <text:span text:style-name="Emphasis">z</text:span></text:p>', auto, s),
		'<p><em>x</em></p><p><strong>y <em>z</em></strong></p>');
});

test('spaces, tabs, line breaks, whitespace, escaping', () => {
	assert.equal(html('<text:p>a<text:s/>b<text:s text:c="3"/>c<text:tab/>d<text:line-break/>e  \n f &lt;b&gt; &amp; "q"</text:p>'),
		'<p>a b   c d<br>e f &lt;b&gt; &amp; "q"</p>');
});

test('links: allowed schemes only', () => {
	assert.equal(html('<text:p><text:a xlink:href="https://example.org/?a=1&amp;b=&quot;2&quot;">x</text:a> ' +
		'<text:a xlink:href="mailto:a@b.c">m</text:a> <text:a xlink:href="#bm">i</text:a> ' +
		'<text:a xlink:href="javascript:alert(1)">j</text:a> <text:a xlink:href="../other.odt">r</text:a></text:p>'),
	'<p><a href="https://example.org/?a=1&amp;b=&quot;2&quot;">x</a> <a href="mailto:a@b.c">m</a> <a href="#bm">i</a> j r</p>');
});

test('images: data URL from the archive, alt text, undisplayable formats skipped', () => {
	const body = '<text:p><draw:frame draw:name="Image1"><draw:image xlink:href="Pictures/a.png"/><svg:title>A &amp; B</svg:title></draw:frame>' +
		'<draw:frame><draw:image xlink:href="ObjectReplacements/Object 1"/></draw:frame>' +
		'<draw:frame><draw:image xlink:href="Pictures/missing.png"/></draw:frame></text:p>';
	assert.equal(html(body, '', null, {'Pictures/a.png': 'data:image/png;base64,AAAA'}),
		'<p><img src="data:image/png;base64,AAAA" alt="A &amp; B"></p>');
});

test('images: embedded binary data (flat ODT) and captioned frames', () => {
	const body = '<text:p><draw:frame><draw:text-box><text:p>' +
		'<draw:frame><draw:image draw:mime-type="image/png"><office:binary-data>iVBO\nRw==</office:binary-data></draw:image></draw:frame>' +
		'Figure 1: Caption</text:p></draw:text-box></draw:frame></text:p>';
	assert.equal(html(body), '<p><img src="data:image/png;base64,iVBORw==" alt="">Figure 1: Caption</p>');
});

test('footnotes and endnotes', () => {
	const body = '<text:p>Text<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation>' +
		'<text:note-body><text:p>Foot</text:p></text:note-body></text:note> and<text:note text:note-class="endnote">' +
		'<text:note-citation>i</text:note-citation><text:note-body><text:p>End</text:p></text:note-body></text:note>' +
		'<text:note text:note-class="footnote"><text:note-citation>2</text:note-citation><text:note-body><text:p>A</text:p><text:p>B</text:p></text:note-body></text:note></text:p>';
	assert.equal(html(body),
		'<p>Text<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup> and<sup><a href="#endnote-1" id="endnote-ref-1">[1]</a></sup>' +
		'<sup><a href="#footnote-2" id="footnote-ref-2">[2]</a></sup></p>' +
		'<ol><li id="footnote-1"><p>Foot <a href="#footnote-ref-1">↑</a></p></li><li id="footnote-2"><p>A</p><p>B <a href="#footnote-ref-2">↑</a></p></li></ol>' +
		'<ol><li id="endnote-1"><p>End <a href="#endnote-ref-1">↑</a></p></li></ol>');
});

test('comments, tracked changes, bookmarks and other markers are dropped', () => {
	const body = '<text:tracked-changes><text:changed-region text:id="ct1"><text:deletion><text:p>DELETED</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
		'<text:sequence-decls><text:sequence-decl text:name="Figure"/></text:sequence-decls>' +
		'<text:p>A<office:annotation office:name="c1"><dc:creator>Reviewer</dc:creator><text:p>SECRET</text:p></office:annotation>B' +
		'<office:annotation-end office:name="c1"/><text:change text:change-id="ct1"/>' +
		'<text:change-start text:change-id="ct2"/>C<text:change-end text:change-id="ct2"/>' +
		'<text:bookmark-start text:name="x"/>D<text:bookmark-end text:name="x"/><text:soft-page-break/>E</text:p>';
	assert.equal(html(body), '<p>ABCDE</p>');
});

// --- render() ---------------------------------------------------------------

test('render: a complete .odt file with an image', async () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const buffer = zip([MIMETYPE,
		manifest('<manifest:file-entry manifest:full-path="Pictures/p.bin" manifest:media-type="image/png"/>'),
		['content.xml', content('<text:p>Hi<draw:frame><draw:image xlink:href="./Pictures/p.bin"/></draw:frame></text:p>')],
		['styles.xml', styles('')],
		['Pictures/p.bin', png, {store: true}]]);
	assert.equal(await odt.render(buffer), '<p>Hi<img src="data:image/png;base64,iVBORw==" alt=""></p>');
});

test('render: a flat .fodt file', async () => {
	const fodt = `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS} office:mimetype="application/vnd.oasis.opendocument.text">` +
		'<office:styles><style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:styles>' +
		'<office:body><office:text><text:p><text:span text:style-name="Strong">Flat</text:span></text:p></office:text></office:body></office:document>';
	assert.equal(await odt.render(text(fodt)), '<p><strong>Flat</strong></p>');
});

test('render: files that cannot be shown', async () => {
	// not a zip and not XML
	await rejectsUnsupported(odt.render(text('%PDF-1.4')));
	// a zip without content.xml (e.g. a DOCX renamed to .odt)
	await rejectsUnsupported(odt.render(zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w/>']])));
	// another OpenDocument type
	await rejectsUnsupported(odt.render(zip([['mimetype', 'application/vnd.oasis.opendocument.spreadsheet', {store: true}],
		['content.xml', content('')]])));
	// encrypted
	await rejectsUnsupported(odt.render(zip([MIMETYPE,
		manifest('<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>'),
		['content.xml', 'garbage', {store: true}]])));
	// broken XML
	await rejectsUnsupported(odt.render(zip([MIMETYPE, ['content.xml', '<office:document-content><unclosed>']])));
	// flat XML that is not a text document
	await rejectsUnsupported(odt.render(text('<?xml version="1.0"?><html/>')));
});
