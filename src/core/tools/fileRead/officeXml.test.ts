import { describe, it, expect } from 'vitest';
import { normalizeXml, parseXml } from './officeXml';

describe('parseXml', () => {
  it('reads single- and double-quoted attributes, spaces around =, CDATA and entities alike', () => {
    const seen: string[] = [];
    let text = '';
    parseXml(`<?xml version='1.0'?><!-- c --><a x = 'one' y="t&amp;&quot;" ><b><![CDATA[a < b & c]]></b><b>a &lt; b &#38; c</b></a>`, {
      open: (name, attributes) => { text = ''; seen.push(`${name}${JSON.stringify(attributes)}`); },
      text: (data) => { text += data; },
      close: (name) => { if (name === 'b') seen.push(`text ${text}`); },
    });
    expect(seen).toEqual(['a{"x":"one","y":"t&\\""}', 'b{}', 'text a < b & c', 'b{}', 'text a < b & c']);
  });

  it('gives the names of known namespaces under one prefix, whatever prefix or default namespace the part uses', () => {
    const names = (xml: string) => {
      const out: string[] = [];
      parseXml(xml, { open: (name, attributes) => out.push(name, ...Object.keys(attributes)) });
      return out;
    };
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    expect(names(`<x:sheet xmlns:x="${main}" xmlns:q="${rel}" name="A" q:id="rId1"/>`)).toEqual(['sheet', 'name', 'r:id']);
    expect(names(`<sheet xmlns="${main}" xmlns:r="${rel}" name="A" r:id="rId1"/>`)).toEqual(['sheet', 'name', 'r:id']);
    // An unprefixed attribute is in no namespace; a prefix that is not declared stays as written.
    expect(names(`<sheet xmlns="${main}" id="1" w:id="2"/>`)).toEqual(['sheet', 'id', 'w:id']);
  });
});

describe('normalizeXml', () => {
  it('writes equivalent XML the same way', () => {
    const plain = '<a x="1"><b>t &amp; u</b><c/></a>';
    expect(normalizeXml(plain)).toBe(plain);
    expect(normalizeXml(`<?xml version="1.0"?><!-- c --><a  x = '1' ><b><![CDATA[t & u]]></b><c></c></a>`)).toBe(plain);
  });
});
