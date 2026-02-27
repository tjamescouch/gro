import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMarkerParser, StreamMarkerParser, extractMarkers } from "../src/stream-markers.js";
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

// ─── Colon format basics ────────────────────────────────────────────

describe("colon format basics", () => {
  it("@@confidence:0.9@@ — single colon marker detected", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@confidence:0.9@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "confidence");
    assert.equal(markers[0].arg, "0.9");
    // confidence is an emotion dim → 😊
    assert.equal(parser.getCleanText(), "\u{1F60A}");
  });

  it("@@joy:0.5,confidence:0.8@@ — multi-value fires handler twice", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@joy:0.5,confidence:0.8@@");
    parser.flush();

    assert.equal(markers.length, 2);
    assert.equal(markers[0].name, "joy");
    assert.equal(markers[0].arg, "0.5");
    assert.equal(markers[1].name, "confidence");
    assert.equal(markers[1].arg, "0.8");
  });

  it("@@calm:1.0@@ — boundary value", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@calm:1.0@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "calm");
    assert.equal(markers[0].arg, "1.0");
  });

  it("@@urgency:0@@ — zero value", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@urgency:0@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "urgency");
    assert.equal(markers[0].arg, "0");
  });

  it("colon marker with surrounding text", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("before @@confidence:0.9@@ after");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "confidence");
    assert.ok(parser.getCleanText().includes("before"));
    assert.ok(parser.getCleanText().includes("after"));
  });
});

// ─── Colon format streaming ─────────────────────────────────────────

describe("colon format streaming", () => {
  it("@@confid + ence:0.9@@ — split across chunks", () => {
    const markers: StreamMarker[] = [];
    const tokens: string[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@confid");
    parser.onToken("ence:0.9@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "confidence");
    assert.equal(markers[0].arg, "0.9");
  });

  it("@@joy:0.5,conf + idence:0.8@@ — split mid multi-value", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@joy:0.5,conf");
    parser.onToken("idence:0.8@@");
    parser.flush();

    assert.equal(markers.length, 2);
    assert.equal(markers[0].name, "joy");
    assert.equal(markers[0].arg, "0.5");
    assert.equal(markers[1].name, "confidence");
    assert.equal(markers[1].arg, "0.8");
  });

  it("colon marker at end of chunk (partial buffering)", () => {
    const tokens: string[] = [];
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onToken: (s) => tokens.push(s),
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("hello @@confidence:0.");
    // Should have emitted "hello " but held back the partial
    assert.equal(tokens.join(""), "hello ");

    parser.onToken("9@@ bye");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "confidence");
  });
});

// ─── Adjacent markers ───────────────────────────────────────────────

describe("adjacent markers", () => {
  it("two function-form markers touching", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@thinking('0.1')@@@@thinking('0.1')@@");
    parser.flush();

    assert.equal(markers.length, 2);
    assert.equal(markers[0].name, "thinking");
    assert.equal(markers[1].name, "thinking");
  });

  it("function-form + colon touching", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@thinking('0.1')@@@@confidence:0.9@@");
    parser.flush();

    assert.equal(markers.length, 2);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("thinking"));
    assert.ok(names.includes("confidence"));
  });

  it("colon + function-form touching", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@confidence:0.9@@@@thinking('0.1')@@");
    parser.flush();

    assert.equal(markers.length, 2);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("confidence"));
    assert.ok(names.includes("thinking"));
  });

  it("two colon markers touching", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@joy:0.5@@@@confidence:0.8@@");
    parser.flush();

    assert.equal(markers.length, 2);
    assert.equal(markers[0].name, "joy");
    assert.equal(markers[0].arg, "0.5");
    assert.equal(markers[1].name, "confidence");
    assert.equal(markers[1].arg, "0.8");
  });

  it("three+ adjacent markers", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@@@confidence:0.9@@@@model-change('opus')@@");
    parser.flush();

    assert.equal(markers.length, 3);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("think"));
    assert.ok(names.includes("confidence"));
    assert.ok(names.includes("model-change"));
  });
});

// ─── Adjacent markers streaming ─────────────────────────────────────

describe("adjacent markers streaming", () => {
  it("adjacent markers split at @@ boundary", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@");
    parser.onToken("@@confidence:0.9@@");
    parser.flush();

    assert.equal(markers.length, 2);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("think"));
    assert.ok(names.includes("confidence"));
  });

  it("first marker complete, second split across chunks", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@@@confid");
    parser.onToken("ence:0.9@@");
    parser.flush();

    assert.equal(markers.length, 2);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("think"));
    assert.ok(names.includes("confidence"));
  });
});

// ─── Mixed format in one stream ─────────────────────────────────────

describe("mixed format in one stream", () => {
  it("function-form, colon, and no-arg interleaved with text", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@thinking('0.5')@@ text @@confidence:0.9@@ more @@relax@@");
    parser.flush();

    assert.equal(markers.length, 3);
    // Colon markers are processed first (more specific), then function-form
    assert.equal(markers[0].name, "confidence");
    assert.equal(markers[0].arg, "0.9");
    assert.equal(markers[1].name, "thinking");
    assert.equal(markers[1].arg, "0.5");
    assert.equal(markers[2].name, "relax");
    assert.equal(markers[2].arg, "");
    assert.ok(parser.getCleanText().includes(" text "));
    assert.ok(parser.getCleanText().includes(" more "));
  });
});

// ─── extractMarkers (non-streaming) ─────────────────────────────────

describe("extractMarkers with colon format", () => {
  it("colon format in extractMarkers", () => {
    const markers: StreamMarker[] = [];
    const cleaned = extractMarkers("hello @@confidence:0.9@@ world", (m) => markers.push(m));

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "confidence");
    assert.equal(markers[0].arg, "0.9");
    assert.ok(cleaned.includes("hello"));
    assert.ok(cleaned.includes("world"));
  });

  it("multi-value colon in extractMarkers", () => {
    const markers: StreamMarker[] = [];
    const cleaned = extractMarkers("@@joy:0.5,confidence:0.8@@", (m) => markers.push(m));

    assert.equal(markers.length, 2);
    assert.equal(markers[0].name, "joy");
    assert.equal(markers[1].name, "confidence");
  });

  it("adjacent markers in extractMarkers", () => {
    const markers: StreamMarker[] = [];
    const cleaned = extractMarkers("@@think@@@@confidence:0.9@@", (m) => markers.push(m));

    assert.equal(markers.length, 2);
    const names = markers.map(m => m.name);
    assert.ok(names.includes("think"));
    assert.ok(names.includes("confidence"));
  });

  it("function-form still works in extractMarkers", () => {
    const markers: StreamMarker[] = [];
    const cleaned = extractMarkers("@@model-change('haiku')@@", (m) => markers.push(m));

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "model-change");
    assert.equal(markers[0].arg, "haiku");
  });
});

// ─── StreamMarkerParser class ───────────────────────────────────────

describe("StreamMarkerParser class", () => {
  it("can be instantiated directly", () => {
    const markers: StreamMarker[] = [];
    const parser = new StreamMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@");
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "think");
  });

  it("reset() clears state for reuse", () => {
    const markers: StreamMarker[] = [];
    const parser = new StreamMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@ first");
    parser.flush();
    assert.equal(markers.length, 1);
    assert.ok(parser.getCleanText().length > 0);

    // Reset and reuse
    markers.length = 0;
    parser.reset();
    assert.equal(parser.getCleanText(), "");
    assert.equal(parser.getMarkers().length, 0);

    parser.onToken("@@relax@@ second");
    parser.flush();
    assert.equal(markers.length, 1);
    assert.equal(markers[0].name, "relax");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────

describe("edge cases", () => {
  it("@@name:@@ — colon with no value does not match colon RE", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@name:@@");
    parser.flush();

    // Should NOT match colon format (no numeric value)
    // May not match function-form either — flushed as text
    assert.equal(markers.length, 0);
  });

  it("@@:0.5@@ — no name does not match", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@:0.5@@");
    parser.flush();

    assert.equal(markers.length, 0);
  });

  it("@@name:abc@@ — non-numeric value does not match colon RE", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@name:abc@@");
    parser.flush();

    // Should not match colon RE (non-numeric value)
    // Might match function-form as @@name@@ with leftover — check no crash
    // The exact behavior depends on regex, but it should not crash
  });

  it("empty stream (no tokens)", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.flush();

    assert.equal(parser.getCleanText(), "");
    assert.equal(markers.length, 0);
  });

  it("only markers, no text", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    parser.onToken("@@think@@@@relax@@");
    parser.flush();

    assert.equal(markers.length, 2);
    // Clean text should only be emojis
    assert.ok(parser.getCleanText().length > 0);
    // No plain text chars
    const text = parser.getCleanText().replace(/[^\x20-\x7E]/g, "");
    assert.equal(text, "");
  });

  it("very long marker arg", () => {
    const markers: StreamMarker[] = [];
    const parser = createMarkerParser({
      onMarker: (m) => markers.push(m),
    });

    const longArg = "a".repeat(1000);
    parser.onToken(`@@callback('${longArg}')@@`);
    parser.flush();

    assert.equal(markers.length, 1);
    assert.equal(markers[0].arg, longArg);
  });
});
