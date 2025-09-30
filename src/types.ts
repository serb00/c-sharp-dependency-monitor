/**
 * Core interfaces for C# Dependency Monitor Extension
 * Based on the Python dependency analyzer algorithm
 */

export interface DependencyNode {
    name: string;
    namespace: string;
    fullName: string;
    filePath: string;
    dependencies: string[];
    dependencyDetails: DependencyDetail[];
}

export interface DependencyDetail {
    target: string;
    reasons: string[];
    lineNumbers: number[];
}

export interface CircularDependency {
    cycle: string[];
    edges: CircularEdge[];
    isNew: boolean;
    discovered: Date;
    id: string; // Unique identifier for tracking
}

export interface CircularEdge {
    from: string;
    to: string;
    reasons: string[];
    filePath?: string;
    lineNumber?: number;
}

export interface AnalysisResult {
    dependencies: Map<string, DependencyNode>;
    circularDependencies: CircularDependency[];
    analysisLevel: AnalysisLevel;
    timestamp: Date;
    affectedFiles: string[];
    totalFiles: number;
}

export type AnalysisLevel = 'namespace' | 'class' | 'system';

export interface CachedAnalysis {
    result: AnalysisResult;
    fileChecksums: Map<string, string>;
    lastModified: Date;
}

export interface FileAnalysisResult {
    filePath: string;
    namespace: string;
    classes: ClassInfo[];
    usingStatements: UsingStatement[];
    dependencies: DependencyNode[];
}

export interface ClassInfo {
    name: string;
    fullName: string;
    namespace: string;
    isNested: boolean;
    startLine: number;
    endLine: number;
    classType: 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
}

export interface UsingStatement {
    namespace: string;
    lineNumber: number;
    isCustom: boolean; // Not System/Unity namespace
}

export interface SystemInfo extends ClassInfo {
    isSystem: boolean;
    systemType: 'ISystem' | 'SystemBase' | 'ComponentSystem' | 'JobComponentSystem' | 'NamedSystem';
}

export interface DependencyPattern {
    pattern: RegExp;
    description: string;
    weight: number; // For prioritizing different types of dependencies
}

export interface AnalysisConfig {
    level: AnalysisLevel;
    ignoredNamespaces: string[];
    projectPaths: string[];
    enableRealTime: boolean;
    enableNotifications: boolean;
    visualization: VisualizationConfig;
}

export interface VisualizationConfig {
    namespaceGrouping: boolean;
    namespaceColoring: boolean;
    typeBasedColoring: boolean;
    enhancedCircularDeps: boolean;
    nodeSelection: boolean;
    colorScheme: ColorScheme;
}

export type ColorScheme = 'default' | 'colorblind' | 'high-contrast';

export interface AnalysisStats {
    totalFiles: number;
    analyzedFiles: number;
    totalDependencies: number;
    circularDependencies: number;
    analysisTime: number;
    cacheHitRate: number;
}

export interface NotificationEvent {
    type: 'circular_dependency_found' | 'analysis_complete' | 'analysis_started' | 'config_changed' | 'cache_cleared' | 'error';
    data: any;
    timestamp: Date;
}

export interface GraphVisualizationData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    circular: boolean;
}

export interface GraphNode {
    id: string;
    label: string;
    namespace?: string;
    isCircular: boolean;
    filePath?: string;
    group?: number;
}

export interface GraphEdge {
    from: string;
    to: string;
    isCircular: boolean;
    reasons: string[];
    weight: number;
}

// Event system for loose coupling between components
export interface EventEmitter<T> {
    on(event: string, listener: (data: T) => void): void;
    off(event: string, listener: (data: T) => void): void;
    emit(event: string, data: T): void;
}

// Error types for better error handling
export class DependencyAnalysisError extends Error {
    constructor(message: string, public filePath?: string, public lineNumber?: number) {
        super(message);
        this.name = 'DependencyAnalysisError';
    }
}

export class CircularDependencyError extends Error {
    constructor(message: string, public cycle: string[]) {
        super(message);
        this.name = 'CircularDependencyError';
    }
}