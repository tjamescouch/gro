import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMarkerParser } from "../src/stream-markers.js";
import type { StreamMarker } from "../src/stream-markers.js";

describe("createMarkerParser", () => {
  it("passes through plain text unchanged", () => {
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("hello ");
    parser.onToken("world");
    parser.flush();

    assert.equal(tokens.join(""), "hello world");
    assert.equal(parser.getCleanText(), "hello world");
    assert.equal(markers.length, 0);
  });

  it("detects a single marker in one chunk", () => {
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("before @@model-change('haiku')@@ after");
    parser.flush();

    assert.equal(tokens.join(""), "before  after");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "model-change");
    assert.equal(markers[0].arg, "haiku");
  });

  it("detects a marker split across token chunks", () => {
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("text @@model");
    parser.onToken("-change('son");
    parser.onToken("net')@@ more text");
    parser.flush();

    assert.equal(parser.getCleanText(), "text  more text");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "model-change");
    assert.equal(markers[0].arg, "sonnet");
  });

  it("handles double-quoted args", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken('@@emotion("happy")@@');
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "emotion");
    assert.equal(markers[0].arg, "happy");
  });

  it("handles unquoted args", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@callback(fire)@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "callback");
    assert.equal(markers[0].arg, "fire");
  });

  it("handles multiple markers in one stream", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@emotion('thinking')@@ Let me think... @@model-change('opus')@@ deep thought @@emotion('eureka')@@");
    parser.flush();

    assert.equal(markers.length, 3);
    assert.equal(markers[0].name, "emotion");
    assert.equal(markers[0].arg, "thinking");
    assert.equal(markers[1].name, "model-change");
    assert.equal(markers[1].arg, "opus");
    assert.equal(markers[2].name, "emotion");
    assert.equal(markers[2].arg, "eureka");
    assert.equal(parser.getCleanText(), " Let me think...  deep thought ");
  });

  it("buffers partial markers at end of chunk", () => {
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    // First chunk ends mid-marker
    parser.onToken("hello @@emo");
    // Should have emitted "hello " but held back "@@emo"
    assert.equal(tokens.join(""), "hello ");

    // Complete the marker
    parser.onToken("tion('sad')@@ bye");
    parser.flush();

    assert.equal(parser.getCleanText(), "hello  bye");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].arg, "sad");
  });

  it("flushes incomplete marker as text on stream end", () => {
    const tokens: string[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: () => {},
    });

    parser.onToken("hello @@broken");
    parser.flush();

    // Incomplete marker should be emitted as regular text
    assert.equal(parser.getCleanText(), "hello @@broken");
  });
});
