import { 
    DependencyNode, 
    CircularDependency, 
    CircularEdge, 
    AnalysisResult 
} from './types';
import { Utils } from './utils';

export class CircularDependencyDetector {
    /**
     * Find circular dependencies using DFS algorithm (ported from Python)
     */
    public findCircularDependencies(dependencies: Map<string, DependencyNode>): CircularDependency[] {
        const circularDeps = new Set<string>();
        const circularNodes = new Set<string>();
        const visited = new Set<string>();
        const recStack = new Set<string>();
        
        // DFS function to detect cycles
        const dfs = (node: string, path: string[]): boolean => {
            if (recStack.has(node)) {
                // Found a cycle - add all edges in the cycle
                try {
                    const cycleStart = path.indexOf(node);
                    const cycle = path.slice(cycleStart).concat([node]);
                    
                    for (let i = 0; i < cycle.length - 1; i++) {
                        const edge = `${cycle[i]} -> ${cycle[i + 1]}`;
                        circularDeps.add(edge);
                        circularNodes.add(cycle[i]);
                        circularNodes.add(cycle[i + 1]);
                    }
                } catch (error) {
                    // Node not in path, just add the direct edge
                    if (path.length > 0) {
                        const edge = `${path[path.length - 1]} -> ${node}`;
                        circularDeps.add(edge);
                        circularNodes.add(path[path.length - 1]);
                        circularNodes.add(node);
                    }
                }
                return true;
            }
            
            if (visited.has(node)) {
                return false;
            }
            
            visited.add(node);
            recStack.add(node);
            
            const dependencyNode = dependencies.get(node);
            if (dependencyNode) {
                for (const neighbor of dependencyNode.dependencies) {
                    if (dfs(neighbor, [...path, node])) {
                        return true;
                    }
                }
            }
            
            recStack.delete(node);
            return false;
        };
        
        // Run DFS for all nodes
        for (const node of dependencies.keys()) {
            if (!visited.has(node)) {
                dfs(node, []);
            }
        }
        
        // Filter to only truly circular edges
        const trulyCircularDeps = new Set<string>();
        for (const edge of circularDeps) {
            const [fromNode, toNode] = edge.split(' -> ');
            if (this.isEdgeTrulyCircular(fromNode, toNode, dependencies)) {
                trulyCircularDeps.add(edge);
            }
        }
        
        // Convert to CircularDependency objects
        return this.buildCircularDependencyObjects(trulyCircularDeps, dependencies);
    }
    
    /**
     * Check if this specific edge is part of a circular path (ported from Python)
     */
    private isEdgeTrulyCircular(
        fromNode: string, 
        toNode: string, 
        dependencies: Map<string, DependencyNode>
    ): boolean {
        // Start from toNode and see if we can reach fromNode
        const visitedForPath = new Set<string>();
        
        const canReachBack = (current: string, target: string): boolean => {
            if (current === target) {
                return true;
            }
            if (visitedForPath.has(current)) {
                return false;
            }
            visitedForPath.add(current);
            
            const currentNode = dependencies.get(current);
            if (currentNode) {
                for (const neighbor of currentNode.dependencies) {
                    if (canReachBack(neighbor, target)) {
                        return true;
                    }
                }
            }
            return false;
        };
        
        return canReachBack(toNode, fromNode);
    }
    
    /**
     * Build CircularDependency objects from edge strings
     */
    private buildCircularDependencyObjects(
        circularEdges: Set<string>, 
        dependencies: Map<string, DependencyNode>
    ): CircularDependency[] {
        const cycles = this.extractCycles(circularEdges);
        const circularDependencies: CircularDependency[] = [];
        
        for (const cycle of cycles) {
            const edges: CircularEdge[] = [];
            
            // Build edges for this cycle
            for (let i = 0; i < cycle.length; i++) {
                const fromNode = cycle[i];
                const toNode = cycle[(i + 1) % cycle.length];
                
                const fromDependency = dependencies.get(fromNode);
                if (fromDependency) {
                    // Find the specific dependency detail for this edge
                    const dependencyDetail = fromDependency.dependencyDetails.find(
                        detail => detail.target === toNode
                    );
                    
                    edges.push({
                        from: fromNode,
                        to: toNode,
                        reasons: dependencyDetail?.reasons || ['Unknown dependency'],
                        filePath: fromDependency.filePath,
                        lineNumber: dependencyDetail?.lineNumbers[0]
                    });
                }
            }
            
            const circularDep: CircularDependency = {
                cycle,
                edges,
                isNew: true, // Will be determined by comparing with previous results
                discovered: new Date(),
                id: Utils.generateCircularDependencyId(cycle)
            };
            
            circularDependencies.push(circularDep);
        }
        
        return circularDependencies;
    }
    
    /**
     * Extract individual cycles from a set of circular edges
     */
    private extractCycles(circularEdges: Set<string>): string[][] {
        const edgeMap = new Map<string, string[]>();
        
        // Build adjacency map from circular edges
        for (const edge of circularEdges) {
            const [from, to] = edge.split(' -> ');
            if (!edgeMap.has(from)) {
                edgeMap.set(from, []);
            }
            edgeMap.get(from)!.push(to);
        }
        
        const cycles: string[][] = [];
        const visited = new Set<string>();
        
        // Find cycles using DFS
        const findCycle = (node: string, path: string[], pathSet: Set<string>): void => {
            if (pathSet.has(node)) {
                // Found a cycle
                const cycleStart = path.indexOf(node);
                const cycle = path.slice(cycleStart);
                cycles.push([...cycle]);
                return;
            }
            
            if (visited.has(node)) {
                return;
            }
            
            visited.add(node);
            pathSet.add(node);
            path.push(node);
            
            const neighbors = edgeMap.get(node) || [];
            for (const neighbor of neighbors) {
                findCycle(neighbor, path, pathSet);
            }
            
            path.pop();
            pathSet.delete(node);
        };
        
        // Start DFS from each unvisited node
        for (const node of edgeMap.keys()) {
            if (!visited.has(node)) {
                findCycle(node, [], new Set());
            }
        }
        
        return this.deduplicateCycles(cycles);
    }
    
    /**
     * Remove duplicate cycles (same cycle starting from different points)
     */
    private deduplicateCycles(cycles: string[][]): string[][] {
        const normalizedCycles = new Set<string>();
        const uniqueCycles: string[][] = [];
        
        for (const cycle of cycles) {
            // Normalize cycle by starting from the lexicographically smallest element
            const sortedNodes = [...cycle].sort();
            const minNode = sortedNodes[0];
            const minIndex = cycle.indexOf(minNode);
            const normalizedCycle = [
                ...cycle.slice(minIndex),
                ...cycle.slice(0, minIndex)
            ];
            
            const cycleKey = normalizedCycle.join(' -> ');
            if (!normalizedCycles.has(cycleKey)) {
                normalizedCycles.add(cycleKey);
                uniqueCycles.push(normalizedCycle);
            }
        }
        
        return uniqueCycles;
    }
    
    /**
     * Compare new circular dependencies with previous ones to identify which are new
     */
    public markNewCircularDependencies(
        currentCircular: CircularDependency[], 
        previousCircular: CircularDependency[]
    ): CircularDependency[] {
        const previousIds = new Set(previousCircular.map(cd => cd.id));
        
        return currentCircular.map(circular => ({
            ...circular,
            isNew: !previousIds.has(circular.id)
        }));
    }
    
    /**
     * Get statistics about circular dependencies
     */
    public getCircularDependencyStats(circularDependencies: CircularDependency[]): {
        totalCircular: number;
        newCircular: number;
        affectedNodes: number;
        averageCycleLength: number;
        longestCycle: number;
        cycleLengthDistribution: Map<number, number>;
    } {
        const affectedNodes = new Set<string>();
        const cycleLengths: number[] = [];
        const cycleLengthDistribution = new Map<number, number>();
        
        for (const circular of circularDependencies) {
            circular.cycle.forEach(node => affectedNodes.add(node));
            cycleLengths.push(circular.cycle.length);
            
            const length = circular.cycle.length;
            cycleLengthDistribution.set(length, (cycleLengthDistribution.get(length) || 0) + 1);
        }
        
        const averageCycleLength = cycleLengths.length > 0 
            ? cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length 
            : 0;
        
        const longestCycle = cycleLengths.length > 0 ? Math.max(...cycleLengths) : 0;
        const newCircular = circularDependencies.filter(cd => cd.isNew).length;
        
        return {
            totalCircular: circularDependencies.length,
            newCircular,
            affectedNodes: affectedNodes.size,
            averageCycleLength,
            longestCycle,
            cycleLengthDistribution
        };
    }
    
    /**
     * Get detailed information about a specific circular dependency
     */
    public getCircularDependencyDetails(
        circularDependency: CircularDependency,
        dependencies: Map<string, DependencyNode>
    ): {
        cycle: string;
        totalEdges: number;
        detailedReasons: Array<{
            from: string;
            to: string;
            reasons: string[];
            filePath: string;
            lineNumbers: number[];
        }>;
    } {
        const cycle = circularDependency.cycle.join(' → ');
        const detailedReasons: Array<{
            from: string;
            to: string;
            reasons: string[];
            filePath: string;
            lineNumbers: number[];
        }> = [];
        
        for (const edge of circularDependency.edges) {
            const fromNode = dependencies.get(edge.from);
            if (fromNode) {
                const dependencyDetail = fromNode.dependencyDetails.find(
                    detail => detail.target === edge.to
                );
                
                detailedReasons.push({
                    from: edge.from,
                    to: edge.to,
                    reasons: edge.reasons,
                    filePath: fromNode.filePath,
                    lineNumbers: dependencyDetail?.lineNumbers || []
                });
            }
        }
        
        return {
            cycle,
            totalEdges: circularDependency.edges.length,
            detailedReasons
        };
    }
    
    /**
     * Suggest potential fixes for circular dependencies
     */
    public suggestCircularDependencyFixes(
        circularDependency: CircularDependency,
        dependencies: Map<string, DependencyNode>
    ): Array<{
        type: 'extract_interface' | 'dependency_injection' | 'move_common_code' | 'break_cycle';
        description: string;
        affectedFiles: string[];
        priority: 'high' | 'medium' | 'low';
    }> {
        const suggestions: Array<{
            type: 'extract_interface' | 'dependency_injection' | 'move_common_code' | 'break_cycle';
            description: string;
            affectedFiles: string[];
            priority: 'high' | 'medium' | 'low';
        }> = [];
        
        // Analyze the cycle to suggest appropriate fixes
        const cycleLength = circularDependency.cycle.length;
        const affectedFiles = [...new Set(circularDependency.edges.map(edge => {
            const fromNode = dependencies.get(edge.from);
            return fromNode?.filePath || '';
        }).filter(path => path))];
        
        if (cycleLength === 2) {
            // Simple bidirectional dependency
            suggestions.push({
                type: 'extract_interface',
                description: 'Extract a common interface to break the bidirectional dependency',
                affectedFiles,
                priority: 'high'
            });
            
            suggestions.push({
                type: 'dependency_injection',
                description: 'Use dependency injection to invert one of the dependencies',
                affectedFiles,
                priority: 'medium'
            });
        } else if (cycleLength > 2) {
            // Complex cycle
            suggestions.push({
                type: 'move_common_code',
                description: 'Move common functionality to a shared component',
                affectedFiles,
                priority: 'high'
            });
            
            suggestions.push({
                type: 'break_cycle',
                description: `Break the cycle by removing the weakest dependency link`,
                affectedFiles,
                priority: 'medium'
            });
        }
        
        return suggestions;
    }
}