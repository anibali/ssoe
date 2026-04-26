import * as vscode from "vscode";
import * as logger from "./logger";

/**
 * Issue format from LLM analysis (matches design doc)
 */
export interface LlmIssue {
  context: string;           // Few surrounding lines
  verbatim: string;           // Exact problematic substring
  description: string;        // Short description
  failure_scenario: string;   // "This will cause a problem when..."
  severity: "error" | "warning" | "info";  // Determines squiggly color (error=red, warning=yellow)
}

interface CachedResult {
  issues: LlmIssue[];
  timestamp: number;
}

/**
 * Cache for incremental analysis results.
 * Keyed by (filePath, nodeHash) to avoid re-analyzing unchanged nodes.
 */
class AnalysisCache {
  // Map<filePath, Map<nodeHash, CachedResult>>
  private cache: Map<string, Map<string, CachedResult>>;

  constructor() {
    this.cache = new Map();
    logger.log("AnalysisCache: initialized");
  }

  /**
   * Get cached issues for a given file and node hash.
   * Returns undefined if not found or expired.
   */
  get(filePath: string, nodeHash: string): LlmIssue[] | undefined {
    const fileCache = this.cache.get(filePath);
    if (!fileCache) {
      return undefined;
    }

    const cached = fileCache.get(nodeHash);
    if (!cached) {
      return undefined;
    }

    logger.log(`AnalysisCache: HIT for ${filePath} (hash: ${nodeHash.slice(0, 8)}...)`);
    return cached.issues;
  }

  /**
   * Store issues in cache for a given file and node hash.
   */
  set(filePath: string, nodeHash: string, issues: LlmIssue[]): void {
    if (!this.cache.has(filePath)) {
      this.cache.set(filePath, new Map());
    }

    const fileCache = this.cache.get(filePath)!;
    fileCache.set(nodeHash, {
      issues,
      timestamp: Date.now(),
    });

    logger.log(`AnalysisCache: SET for ${filePath} (hash: ${nodeHash.slice(0, 8)}..., issues: ${issues.length})`);
  }

  /**
   * Remove stale cache entries for a file.
   * Keeps only entries whose hashes are in `validHashes`.
   */
  removeStaleEntries(filePath: string, validHashes: Set<string>): void {
    const fileCache = this.cache.get(filePath);
    if (!fileCache) {
      return;
    }

    const keysToRemove: string[] = [];
    for (const hash of fileCache.keys()) {
      if (!validHashes.has(hash)) {
        keysToRemove.push(hash);
      }
    }

    for (const hash of keysToRemove) {
      fileCache.delete(hash);
      logger.log(`AnalysisCache: removed stale entry ${hash.slice(0, 8)}... for ${filePath}`);
    }

    // Clean up empty file cache
    if (fileCache.size === 0) {
      this.cache.delete(filePath);
    }

    if (keysToRemove.length > 0) {
      logger.log(`AnalysisCache: removed ${keysToRemove.length} stale entries for ${filePath}`);
    }
  }
}

// Export singleton instance
export const analysisCache = new AnalysisCache();
