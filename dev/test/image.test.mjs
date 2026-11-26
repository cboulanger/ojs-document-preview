// Tests for js/renderers/image.js (run: cd dev && npm test).
// Only the parts that need no browser: recognising the format and the HTML.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const require = createRequire(import.meta.url);
const image = require('../../js/renderers/image.js');

const bytes = (...parts) => {
	const chunks = parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
	const buffer = Buffer.concat(chunks);
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
};
const type = (...parts) => image.detectType(bytes(...parts));

test('recognises raster formats by their first bytes', () => {
	assert.equal(type(readFileSync(new URL('samples/figure.png', import.meta.url))), 'image/png');
	assert.equal(type([0x89], 'PNG\r\n\x1a\n', 'rest'), 'image/png');
	assert.equal(type([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), 'image/jpeg');
	assert.equal(type('GIF89a', [1, 0, 1, 0]), 'image/gif');
	assert.equal(type('GIF87a'), 'image/gif');
	assert.equal(type('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'image/webp');
	assert.equal(type('BM', new Uint8Array(20)), 'image/bmp');
});

test('recognises AVIF by its major or a compatible brand', () => {
	assert.equal(type([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf'), 'image/avif');
	assert.equal(type([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0], 'avifmiaf'), 'image/avif');
	// HEIC is the same container, but browsers (except Safari) can't show it
	assert.equal(type([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic'), null);
	// "avif" as the minor version doesn't count
	assert.equal(type([0, 0, 0, 0x10], 'ftypmif1avif'), null);
});

test('recognises SVG with a declaration, comments and a doctype', () => {
	assert.equal(type('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
	assert.equal(type('﻿'.replace(/./, '\xef\xbb\xbf'), '<?xml version="1.0"?>\n<!-- Inkscape -->\n' +
		'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg>'), 'image/svg+xml');
	assert.equal(type('<svg:svg xmlns:svg="http://www.w3.org/2000/svg">'), 'image/svg+xml');
	assert.equal(type('<html><body><svg></svg></body></html>'), null);
	assert.equal(type('<svgfoo/>'), null);
});

test('rejects other files', () => {
	assert.equal(type('%PDF-1.7'), null);
	assert.equal(type('PK\x03\x04'), null);
	assert.equal(type(''), null);
	assert.equal(type('B'), null);
});

test('HTML: the image with the file name as text alternative, escaped', () => {
	const html = image.toHtml('data:image/png;base64,AAAA', 'a "b" <c> & d.png');
	assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="a &quot;b&quot; &lt;c> &amp; d.png">/);
	assert.match(html, /<input type="checkbox" class="zoom" id="zoom"><label for="zoom">/);
	assert.doesNotMatch(html, /<script/i);
});
