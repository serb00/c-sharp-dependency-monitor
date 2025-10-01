import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DependencyNode, AnalysisResult, AnalysisLevel } from './types';
import { Utils } from './utils';
import { ConfigManager } from './configManager';

/**
 * Interface for cached dependency data
 */
export interface CachedDependencyData {
    dependencies: Map<string, DependencyNode>;
    circularDependencies: any[];
    analysisLevel: AnalysisLevel;
    timestamp: number;
    fileHashes: Map<string, string>;
    totalFiles: number;
    version: string;
}

/**
 * Interface for file-level cache entry
 */
export interface CachedFileData {
    filePath: string;
    hash: string;
    lastModified: number;
    namespace: string;
    classes: string[];
    dependencies: string[];
    lastAnalyzed: number;
}

/**
 * Interface for cache metadata
 */
export interface CacheMetadata {
    version: string;
    lastFullAnalysis: number;
    totalCachedFiles: number;
    analysisLevel: AnalysisLevel;
    workspaceRoot: string;
    cacheCreated: number;
}

/**
 * Advanced caching system for dependency analysis optimization
 */
export class CacheManager {
    private static readonly CACHE_VERSION = '1.0.0';
    private static readonly CACHE_DIR = '.vscode/dependency-cache';
    private static readonly CACHE_FILE = 'dependencies.json';
    private static readonly FILES_CACHE_FILE = 'files.json';
    private static readonly METADATA_FILE = 'metadata.json';
    
    private memoryCache: Map<AnalysisLevel, CachedDependencyData> = new Map();
    private fileCache: Map<string, CachedFileData> = new Map();
    private cacheDir: string;
    private outputChannel: vscode.OutputChannel;
    private isInitialized = false;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.cacheDir = '';
    }

    /**
     * Initialize the cache manager
     */
    public async initialize(workspaceRoot: string): Promise<void> {
        try {
            this.cacheDir = path.join(workspaceRoot, CacheManager.CACHE_DIR);
            await this.ensureCacheDirectory();
            await this.loadCaches();
            this.isInitialized = true;
            this.outputChannel.appendLine(`Cache manager initialized: ${this.cacheDir}`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to initialize cache: ${error}`);
        }
    }

    /**
     * Get cached analysis result if valid
     */
    public async getCachedAnalysis(
        analysisLevel: AnalysisLevel,
        changedFiles: string[] = []
    ): Promise<AnalysisResult | null> {
        if (!this.isInitialized) {
            return null;
        }

        try {
            const cached = this.memoryCache.get(analysisLevel);
            if (!cached) {
                this.outputChannel.appendLine(`No cache found for level: ${analysisLevel}`);
                return null;
            }

            // Check if cache is still valid
            if (changedFiles.length > 0) {
                const isValid = await this.isCacheValid(cached, changedFiles);
                if (!isValid) {
                    this.outputChannel.appendLine(`Cache invalidated due to file changes: ${changedFiles.length} files`);
                    return null;
                }
            }

            // Check cache age (max 24 hours for full cache, but prioritize file-based invalidation)
            const cacheAge = Date.now() - cached.timestamp;
            const maxAge = 24 * 60 * 60 * 1000; // 24 hours - much longer, rely on file change detection
            if (cacheAge > maxAge) {
                this.outputChannel.appendLine(`Cache expired (age: ${Utils.formatDuration(cacheAge)})`);
                return null;
            }

            this.outputChannel.appendLine(`Using cached analysis (${cached.dependencies.size} dependencies)`);
            
            return {
                dependencies: cached.dependencies,
                circularDependencies: [], // Will be populated by CircularDependencyDetector in the caller
                analysisLevel: cached.analysisLevel,
                timestamp: new Date(cached.timestamp),
                totalFiles: cached.totalFiles,
                affectedFiles: [] // Cache doesn't track specific affected files
            };

        } catch (error) {
            this.outputChannel.appendLine(`Error retrieving cached analysis: ${error}`);
            return null;
        }
    }

    /**
     * Cache analysis result
     */
    public async cacheAnalysis(result: AnalysisResult): Promise<void> {
        if (!this.isInitialized) {
            return;
        }

        try {
            // Calculate file hashes for the current analysis
            const fileHashes = await this.calculateFileHashes(result.dependencies);

            const cachedData: CachedDependencyData = {
                dependencies: result.dependencies,
                circularDependencies: result.circularDependencies,
                analysisLevel: result.analysisLevel,
                timestamp: Date.now(),
                fileHashes,
                totalFiles: result.totalFiles,
                version: CacheManager.CACHE_VERSION
            };

            // Update memory cache
            this.memoryCache.set(result.analysisLevel, cachedData);

            // Save to disk
            await this.saveCacheToDisk(result.analysisLevel, cachedData);
            await this.updateMetadata(result);

            this.outputChannel.appendLine(
                `Cached analysis result: ${result.dependencies.size} dependencies, ` +
                `${result.circularDependencies.length} circular, level: ${result.analysisLevel}`
            );

        } catch (error) {
            this.outputChannel.appendLine(`Error caching analysis: ${error}`);
        }
    }

    /**
     * Get cached file data
     */
    public getCachedFileData(filePath: string): CachedFileData | null {
        return this.fileCache.get(filePath) || null;
    }

    /**
     * Get the entire file cache map
     */
    public getFileCache(): Map<string, CachedFileData> {
        return this.fileCache;
    }

    /**
     * Get the last analysis time from metadata
     */
    public getLastAnalysisTime(): number | undefined {
        // Find the most recent timestamp from memory cache
        let latestTime = 0;
        for (const data of this.memoryCache.values()) {
            if (data.timestamp > latestTime) {
                latestTime = data.timestamp;
            }
        }
        return latestTime > 0 ? latestTime : undefined;
    }

    /**
     * Update file cache entry
     */
    public async updateFileCache(
        filePath: string,
        namespace: string,
        classes: string[],
        dependencies: string[]
    ): Promise<void> {
        try {
            const hash = await Utils.calculateFileHash(filePath);
            const stats = await fs.stat(filePath);
            
            const fileData = Utils.createFileCacheEntry(
                filePath,
                hash,
                stats.mtime.getTime(),
                namespace,
                classes,
                dependencies
            );
            this.fileCache.set(filePath, fileData);
            await this.saveFileCache();

        } catch (error) {
            this.outputChannel.appendLine(`Error updating file cache for ${filePath}: ${error}`);
        }
    }

    /**
     * Invalidate cache for specific files
     */
    public async invalidateFiles(filePaths: string[]): Promise<void> {
        try {
            this.outputChannel.appendLine(`🔧 CACHE INVALIDATION: Processing ${filePaths.length} files`);
            
            const result = Utils.invalidateUnifiedCache(
                filePaths,
                this.fileCache,
                this.memoryCache
            );

            if (result.invalidatedFiles.length > 0) {
                await this.saveFileCache();
                this.outputChannel.appendLine(`✅ CACHE INVALIDATION COMPLETE: ${result.invalidatedFiles.length} files invalidated (including ${result.dependentFiles.length} dependents)`);
            } else {
                this.outputChannel.appendLine(`ℹ️ CACHE INVALIDATION COMPLETE: No files were in cache, but memory cache cleared`);
            }

        } catch (error) {
            this.outputChannel.appendLine(`❌ Error invalidating file cache: ${error}`);
        }
    }

    /**
     * Invalidate cache for all analysis levels when files change
     * This ensures that namespace and class level caches are all updated
     */
    public async invalidateAllLevels(filePaths: string[]): Promise<void> {
        try {
            this.outputChannel.appendLine(`🔧 MULTI-LEVEL CACHE INVALIDATION: Processing ${filePaths.length} files for all analysis levels`);
            
            const result = Utils.invalidateUnifiedCache(
                filePaths,
                this.fileCache,
                this.memoryCache
            );

            if (result.invalidatedFiles.length > 0) {
                await this.saveFileCache();
                this.outputChannel.appendLine(`✅ MULTI-LEVEL INVALIDATION COMPLETE: ${result.invalidatedFiles.length} files invalidated, ALL analysis levels cleared`);
            } else {
                this.outputChannel.appendLine(`ℹ️ MULTI-LEVEL INVALIDATION COMPLETE: No files were in cache, but ALL analysis level caches cleared`);
            }

        } catch (error) {
            this.outputChannel.appendLine(`❌ Error in multi-level cache invalidation: ${error}`);
        }
    }

    /**
     * Get files that depend on the given file
     */
    public getDependentFiles(filePath: string): string[] {
        const fileData = this.fileCache.get(filePath);
        if (!fileData) {
            return [];
        }
        
        return Utils.findDependentFilesFromCache(
            filePath,
            fileData.namespace || '',
            fileData.classes || [],
            this.fileCache
        );
    }

    /**
     * Clear all caches
     */
    public async clearCache(): Promise<void> {
        try {
            this.memoryCache.clear();
            this.fileCache.clear();

            // Remove cache directory
            if (this.cacheDir) {
                await fs.rm(this.cacheDir, { recursive: true, force: true });
                await this.ensureCacheDirectory();
            }

            this.outputChannel.appendLine('All caches cleared');

        } catch (error) {
            this.outputChannel.appendLine(`Error clearing cache: ${error}`);
        }
    }

    /**
     * Get cache statistics
     */
    public getCacheStats(): {
        memoryCache: { [key: string]: number };
        fileCache: number;
        cacheSize: string;
        lastUpdate: string;
    } {
        const memoryCache: { [key: string]: number } = {};
        for (const [level, data] of this.memoryCache) {
            memoryCache[level] = data.dependencies.size;
        }

        const latest = Math.max(...Array.from(this.memoryCache.values()).map(d => d.timestamp), 0);

        return {
            memoryCache,
            fileCache: this.fileCache.size,
            cacheSize: this.formatCacheSize(),
            lastUpdate: latest > 0 ? new Date(latest).toLocaleString() : 'Never'
        };
    }

    /**
     * Export cache for debugging
     */
    public async exportCacheDebugInfo(): Promise<string> {
        const debugInfo = {
            version: CacheManager.CACHE_VERSION,
            timestamp: new Date().toISOString(),
            stats: this.getCacheStats(),
            memoryCache: {},
            fileCache: Array.from(this.fileCache.entries()),
            metadata: await this.loadMetadata()
        };

        // Convert memory cache for serialization
        for (const [level, data] of this.memoryCache) {
            (debugInfo.memoryCache as any)[level] = {
                dependencies: Array.from(data.dependencies.entries()),
                circularDependencies: data.circularDependencies,
                analysisLevel: data.analysisLevel,
                timestamp: data.timestamp,
                totalFiles: data.totalFiles,
                fileHashes: Array.from(data.fileHashes.entries())
            };
        }

        return JSON.stringify(debugInfo, null, 2);
    }

    /**
     * Load and use cached analysis immediately on startup if available
     */
    public async loadStartupCache(): Promise<AnalysisResult | null> {
        try {
            const config = ConfigManager.getInstance().getConfig();
            const cachedResult = await this.getCachedAnalysis(config.level);
            
            if (cachedResult) {
                this.outputChannel.appendLine(`✅ Using startup cache: ${cachedResult.dependencies.size} dependencies (${config.level} level)`);
                return cachedResult;
            } else {
                this.outputChannel.appendLine(`ℹ️ No valid startup cache found for ${config.level} level`);
                return null;
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error loading startup cache: ${error}`);
            return null;
        }
    }

    // Private methods

    private async ensureCacheDirectory(): Promise<void> {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
        } catch (error) {
            throw new Error(`Failed to create cache directory: ${error}`);
        }
    }

    private async loadCaches(): Promise<void> {
        await Promise.all([
            this.loadMemoryCache(),
            this.loadFileCache()
        ]);
    }

    private async loadMemoryCache(): Promise<void> {
        try {
            const levels: AnalysisLevel[] = ['namespace', 'class'];
            
            for (const level of levels) {
                const cachePath = path.join(this.cacheDir, `${level}-${CacheManager.CACHE_FILE}`);
                
                try {
                    const content = await fs.readFile(cachePath, 'utf-8');
                    const data = JSON.parse(content);
                    
                    // Validate cache version
                    if (data.version !== CacheManager.CACHE_VERSION) {
                        this.outputChannel.appendLine(`Cache version mismatch for ${level}, ignoring`);
                        continue;
                    }

                    // Reconstruct Maps from JSON
                    const cachedData: CachedDependencyData = {
                        dependencies: new Map(data.dependencies),
                        circularDependencies: data.circularDependencies,
                        analysisLevel: data.analysisLevel,
                        timestamp: data.timestamp,
                        fileHashes: new Map(data.fileHashes),
                        totalFiles: data.totalFiles,
                        version: data.version
                    };

                    this.memoryCache.set(level, cachedData);
                    this.outputChannel.appendLine(`Loaded ${level} cache: ${cachedData.dependencies.size} dependencies`);

                } catch (fileError) {
                    // Cache file doesn't exist or is corrupted, continue
                    this.outputChannel.appendLine(`No valid cache found for ${level}`);
                }
            }

        } catch (error) {
            this.outputChannel.appendLine(`Error loading memory cache: ${error}`);
        }
    }

    private async loadFileCache(): Promise<void> {
        try {
            const cachePath = path.join(this.cacheDir, CacheManager.FILES_CACHE_FILE);
            const content = await fs.readFile(cachePath, 'utf-8');
            const data = JSON.parse(content);

            // Reconstruct file cache
            for (const [filePath, fileData] of data) {
                this.fileCache.set(filePath, fileData);
            }

            this.outputChannel.appendLine(`Loaded file cache: ${this.fileCache.size} files`);

        } catch (error) {
            this.outputChannel.appendLine(`No file cache found, starting fresh`);
        }
    }

    private async saveCacheToDisk(level: AnalysisLevel, data: CachedDependencyData): Promise<void> {
        try {
            const cachePath = path.join(this.cacheDir, `${level}-${CacheManager.CACHE_FILE}`);
            
            // Convert Maps to arrays for JSON serialization
            const serializable = {
                dependencies: Array.from(data.dependencies.entries()),
                circularDependencies: data.circularDependencies,
                analysisLevel: data.analysisLevel,
                timestamp: data.timestamp,
                fileHashes: Array.from(data.fileHashes.entries()),
                totalFiles: data.totalFiles,
                version: data.version
            };

            await fs.writeFile(cachePath, JSON.stringify(serializable, null, 2));

        } catch (error) {
            this.outputChannel.appendLine(`Error saving cache to disk: ${error}`);
        }
    }

    private async saveFileCache(): Promise<void> {
        try {
            const cachePath = path.join(this.cacheDir, CacheManager.FILES_CACHE_FILE);
            const serializable = Array.from(this.fileCache.entries());
            await fs.writeFile(cachePath, JSON.stringify(serializable, null, 2));

        } catch (error) {
            this.outputChannel.appendLine(`Error saving file cache: ${error}`);
        }
    }

    private async updateMetadata(result: AnalysisResult): Promise<void> {
        try {
            const metadata: CacheMetadata = {
                version: CacheManager.CACHE_VERSION,
                lastFullAnalysis: Date.now(),
                totalCachedFiles: this.fileCache.size,
                analysisLevel: result.analysisLevel,
                workspaceRoot: Utils.getWorkspaceRoot() || '',
                cacheCreated: Date.now()
            };

            const metadataPath = path.join(this.cacheDir, CacheManager.METADATA_FILE);
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

        } catch (error) {
            this.outputChannel.appendLine(`Error updating metadata: ${error}`);
        }
    }

    private async loadMetadata(): Promise<CacheMetadata | null> {
        try {
            const metadataPath = path.join(this.cacheDir, CacheManager.METADATA_FILE);
            const content = await fs.readFile(metadataPath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }

    private async isCacheValid(cached: CachedDependencyData, changedFiles: string[]): Promise<boolean> {
        try {
            return await Utils.validateCacheWithFileChanges(cached.fileHashes, changedFiles);
        } catch (error) {
            this.outputChannel.appendLine(`Error validating cache: ${error}`);
            return false;
        }
    }

    private async calculateFileHashes(dependencies: Map<string, DependencyNode>): Promise<Map<string, string>> {
        return await Utils.calculateFileHashesForGraph(dependencies);
    }

    private async calculateFileHash(filePath: string): Promise<string> {
        return await Utils.calculateFileHash(filePath);
    }

    private formatCacheSize(): string {
        // Rough estimate of cache size
        let size = 0;
        for (const data of this.memoryCache.values()) {
            size += data.dependencies.size * 1000; // Rough estimate per dependency
        }
        size += this.fileCache.size * 500; // Rough estimate per file

        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }
}