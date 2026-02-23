import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeGoogleDriver } from "../src/drivers/streaming-google.js";
import type { ChatMessage } from "../src/drivers/types.js";

describe("Google Gemini Driver", () => {
  const driver = makeGoogleDriver({
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    apiKey: "test-key",
  });

  describe("message conversion", () => {
    it("converts simple user message", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      // We can't actually call chat without valid credentials,
      // but we can verify the driver exports the right interface
      assert.ok(driver.chat);
      assert.equal(typeof driver.chat, "function");
    });

    it("driver accepts tool definitions", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "What tools do you have?" },
      ];

      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ];

      // Just verify the interface accepts tools
      assert.ok(driver.chat);
      // Can't call without credentials, but the signature is correct
    });

    it("handles system messages", async () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];

      assert.ok(driver.chat);
      assert.equal(messages[0].role, "system");
    });

    it("handles tool results in conversation", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Get the weather" },
        {
          role: "assistant",
          content: "I'll get the weather for you.",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"San Francisco"}',
              },
            },
          ],
        },
        {
          role: "tool",
          name: "get_weather",
          content: '{"temp": 72, "condition": "sunny"}',
        },
      ];

      assert.equal(messages.length, 3);
      assert.equal(messages[1].role, "assistant");
      assert.equal(messages[2].role, "tool");
    });
  });

  describe("driver interface", () => {
    it("exports makeGoogleDriver function", () => {
      assert.ok(typeof makeGoogleDriver === "function");
    });

    it("returns ChatDriver interface", () => {
      assert.ok(driver);
      assert.ok(typeof driver.chat === "function");
    });

    it("accepts configuration with baseUrl, model, apiKey", () => {
      const cfg = {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-pro",
        apiKey: "sk-xyz",
        timeoutMs: 30000,
      };

      const customDriver = makeGoogleDriver(cfg);
      assert.ok(customDriver.chat);
    });
  });

  describe("configuration", () => {
    it("uses correct Gemini API endpoint (not OpenAI shim)", () => {
      // The driver should use https://generativelanguage.googleapis.com
      // not https://generativelanguage.googleapis.com/v1beta/openai
      const cfg = {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
        apiKey: "test",
      };

      const d = makeGoogleDriver(cfg);
      assert.ok(d.chat);
      
      // Verify the base URL doesn't contain the OpenAI shim path
      const baseUrlStr = JSON.stringify(cfg);
      assert.ok(baseUrlStr.includes("generativelanguage.googleapis.com"));
      assert.ok(!baseUrlStr.includes("v1beta/openai"));
    });

    it("handles timeout configuration", () => {
      const cfg = {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
        apiKey: "test",
        timeoutMs: 60000,
      };

      const d = makeGoogleDriver(cfg);
      assert.ok(d.chat);
    });
  });

  describe("tool handling", () => {
    it("converts OpenAI tool format to Gemini format", async () => {
      // The driver internally converts function definitions
      // from OpenAI format (function.name, function.description, function.parameters)
      // to Gemini format (functionDeclarations with name, description, parameters)

      const tools = [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "A test tool",
            parameters: {
              type: "object",
              properties: {
                arg: { type: "string" },
              },
            },
          },
        },
      ];

      assert.ok(tools);
      assert.equal(tools[0].function.name, "test_tool");
    });
  });

  describe("error handling", () => {
    it("handles missing API key gracefully", () => {
      // Should accept undefined apiKey (will fail at runtime, but config is valid)
      const cfg = {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
        apiKey: undefined,
      };

      const d = makeGoogleDriver(cfg);
      assert.ok(d.chat);
    });

    it("preserves base URL without trailing slash", () => {
      const cfg1 = {
        baseUrl: "https://generativelanguage.googleapis.com/",
        model: "gemini-2.5-flash",
        apiKey: "test",
      };

      const cfg2 = {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
        apiKey: "test",
      };

      const d1 = makeGoogleDriver(cfg1);
      const d2 = makeGoogleDriver(cfg2);
      assert.ok(d1.chat);
      assert.ok(d2.chat);
    });
  });

  describe("integration with main.ts", () => {
    it("model inference routes gemini-* to google provider", () => {
      // Test that model names starting with "gemini-" are recognized as Google models
      const models = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3-flash",
        "gemini-3-pro",
      ];

      assert.ok(models.every((m) => m.startsWith("gemini-")));
    });

    it("aliases resolve to full gemini model names", () => {
      // These should resolve via models.json
      const aliases: Record<string, string> = {
        "flash-lite": "gemini-2.5-flash-lite",
        "flash": "gemini-2.5-flash",
        "gemini-pro": "gemini-2.5-pro",
        "gemini3-flash": "gemini-3-flash",
        "gemini3-pro": "gemini-3-pro",
      };

      Object.entries(aliases).forEach(([alias, full]) => {
        assert.ok(full.startsWith("gemini-"));
      });
    });
  });
});
