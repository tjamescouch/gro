/**
 * Anthropic Message Batches API client.
 * 
 * Batch processing: 50% discount on input + output tokens, 5min-24hr latency.
 * https://docs.anthropic.com/en/api/batch-api
 */

import { Logger } from "../../logger.js";
import { timedFetch } from "../../utils/timed-fetch.js";
import { groError } from "../../errors.js";

export interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: any[];
    system?: string;
  };
}

export interface BatchStatus {
  id: string;
  processing_status: "in_progress" | "ended";
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at?: string;
  results_url?: string;
  expires_at: string;
  created_at: string;
}

export interface BatchResult {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "expired" | "canceled";
    message?: {
      id: string;
      type: "message";
      role: "assistant";
      content: Array<{ type: "text"; text: string }>;
      model: string;
      stop_reason: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };
    error?: {
      type: string;
      message: string;
    };
  };
}

export class AnthropicBatchClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Submit a batch of requests. Returns batch_id.
   */
  async submitBatch(requests: BatchRequest[]): Promise<string> {
    if (requests.length === 0) {
      throw groError("batch_error", "Cannot submit empty batch");
    }
    if (requests.length > 10000) {
      throw groError("batch_error", "Batch size exceeds 10,000 request limit");
    }

    const url = `${this.baseUrl}/messages/batches`;
    const headers = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey,
      "content-type": "application/json",
    };

    const body = { requests };

    Logger.info(`[Batch] Submitting batch with ${requests.length} requests`);

    try {
      const res = await timedFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw groError(
          "batch_error",
          `Batch submission failed: ${res.status} ${text}`,
        );
      }

      const data = await res.json();
      const batchId = data.id;
      Logger.info(`[Batch] Submitted: ${batchId}`);
      return batchId;
    } catch (e) {
      Logger.error(`[Batch] Submission error:`, e);
      throw e;
    }
  }

  /**
   * Get status of a batch.
   */
  async getBatchStatus(batchId: string): Promise<BatchStatus> {
    const url = `${this.baseUrl}/messages/batches/${batchId}`;
    const headers = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey,
    };

    try {
      const res = await timedFetch(url, { headers });

      if (!res.ok) {
        const text = await res.text();
        throw groError(
          "batch_error",
          `Batch status fetch failed: ${res.status} ${text}`,
        );
      }

      return await res.json();
    } catch (e) {
      Logger.error(`[Batch] Status error for ${batchId}:`, e);
      throw e;
    }
  }

  /**
   * Download and parse batch results from results_url.
   * Returns array of BatchResult (one per request).
   */
  async downloadResults(resultsUrl: string): Promise<BatchResult[]> {
    const headers = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey,
    };

    try {
      const res = await timedFetch(resultsUrl, { headers });

      if (!res.ok) {
        const text = await res.text();
        throw groError(
          "batch_error",
          `Results download failed: ${res.status} ${text}`,
        );
      }

      const text = await res.text();
      const lines = text.trim().split("\n");
      const results: BatchResult[] = [];

      for (const line of lines) {
        if (line.trim()) {
          try {
            results.push(JSON.parse(line));
          } catch (e) {
            Logger.warn(`[Batch] Failed to parse result line: ${line}`);
          }
        }
      }

      return results;
    } catch (e) {
      Logger.error(`[Batch] Results download error:`, e);
      throw e;
    }
  }

  /**
   * Cancel a batch in progress.
   */
  async cancelBatch(batchId: string): Promise<void> {
    const url = `${this.baseUrl}/messages/batches/${batchId}/cancel`;
    const headers = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey,
      "content-type": "application/json",
    };

    try {
      const res = await timedFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const text = await res.text();
        throw groError(
          "batch_error",
          `Batch cancel failed: ${res.status} ${text}`,
        );
      }

      Logger.info(`[Batch] Canceled: ${batchId}`);
    } catch (e) {
      Logger.error(`[Batch] Cancel error for ${batchId}:`, e);
      throw e;
    }
  }
}
