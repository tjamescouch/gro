import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMarkerParser } from "../src/stream-markers.js";
import type { StreamMarker } from "../src/stream-markers.js";
import { Logger } from "../src/logger.js";

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
    Logger.setVerbose(true);
    try {
      const tokens: string[] = [];
      const markers: StreamMarker[] = [];
      const parser = createMarkerParser({
        onToken: (s) => tokens.push(s),
        onMarker: (m) => markers.push(m),
      });

      parser.onToken("before @@model-change('haiku')@@ after");
      parser.flush();

      assert.equal(tokens.join(""), "before \u{1F500} after");
      assert.equal(markers.length, 1);
      assert.equal(markers[0].name, "model-change");
      assert.equal(markers[0].arg, "haiku");
    } finally {
      Logger.setVerbose(false);
    }
  });

  it("suppresses marker emojis from onToken in default mode", () => {
    Logger.setVerbose(false);
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("before @@model-change('haiku')@@ after");
    parser.flush();

    // Emoji suppressed from onToken stream in default mode
    assert.equal(tokens.join(""), "before  after");
    // But cleanText still includes the emoji
    assert.equal(parser.getCleanText(), "before \u{1F500} after");
    assert.equal(markers.length, 1);
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

    assert.equal(parser.getCleanText(), "text \u{1F500} more text");
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
    // emotion → 🧠 (reserved, not in EMOTION_DIMS), model-change → 🔀
    assert.equal(parser.getCleanText(), "\u{1F9E0} Let me think... \u{1F500} deep thought \u{1F9E0}");
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

    assert.equal(parser.getCleanText(), "hello \u{1F9E0} bye"); // emotion → 🧠 fallback (not in EMOTION_DIMS)
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

  it("handles no-arg markers like @@think@@ with 🦉 emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("Let me @@think@@ about this");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "think");
    assert.equal(markers[0].arg, "");
    // think is a thinking marker → 🦉
    assert.equal(parser.getCleanText(), "Let me \u{1F989} about this");
  });

  it("handles no-arg markers like @@relax@@ with 🦉 emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("Done @@relax@@ now");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "relax");
    assert.equal(markers[0].arg, "");
    // relax is a thinking marker → 🦉
    assert.equal(parser.getCleanText(), "Done \u{1F989} now");
  });

  it("handles mixed no-arg and arg markers with correct emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@ Let me think... @@model-change('opus')@@ @@relax@@ done");
    parser.flush();

    assert.equal(markers.length, 3);
    assert.equal(markers[0].name, "think");
    assert.equal(markers[0].arg, "");
    assert.equal(markers[1].name, "model-change");
    assert.equal(markers[1].arg, "opus");
    assert.equal(markers[2].name, "relax");
    assert.equal(markers[2].arg, "");
    // think/relax → 🦉, model-change → 🔀
    assert.equal(parser.getCleanText(), "\u{1F989} Let me think... \u{1F500} \u{1F989} done");
  });

  it("handles no-arg marker split across chunks", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("text @@thi");
    parser.onToken("nk@@ more");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "think");
    assert.equal(markers[0].arg, "");
    assert.equal(parser.getCleanText(), "text \u{1F989} more");
  });

  it("@@thinking(0.8)@@ gets 🦉 emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@thinking(0.8)@@ deep work");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "thinking");
    assert.equal(markers[0].arg, "0.8");
    assert.equal(parser.getCleanText(), "\u{1F989} deep work");
  });

  it("@@importance('0.9')@@ gets ⚖️ emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@importance('0.9')@@ critical info");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "importance");
    assert.equal(markers[0].arg, "0.9");
    assert.equal(parser.getCleanText(), "\u{2696}\u{FE0F} critical info");
  });

  it("@@max-context('200k')@@ gets 📐 emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@max-context('200k')@@ expanded");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "max-context");
    assert.equal(markers[0].arg, "200k");
    assert.equal(parser.getCleanText(), "\u{1F4D0} expanded");
  });

  it("@@max-context('1mb')@@ gets 📐 emoji", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@max-context('1mb')@@ full context");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "max-context");
    assert.equal(markers[0].arg, "1mb");
    assert.equal(parser.getCleanText(), "\u{1F4D0} full context");
  });
});
