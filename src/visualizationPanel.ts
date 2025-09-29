import * as vscode from 'vscode';
import { AnalysisResult, CircularDependency, DependencyNode, GraphVisualizationData, AnalysisLevel } from './types';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import { CacheManager } from './cacheManager';
import { CircularDependencyDetector } from './circularDependencyDetector';

export class VisualizationPanel {
    private panel: vscode.WebviewPanel | undefined;
    private configManager: ConfigManager;
    private outputChannel: vscode.OutputChannel;
    private cacheManager: CacheManager;
    private currentAnalysisResult: AnalysisResult | undefined;
    
    constructor(outputChannel: vscode.OutputChannel, cacheManager: CacheManager) {
        this.configManager = ConfigManager.getInstance();
        this.outputChannel = outputChannel;
        this.cacheManager = cacheManager;
    }

    /**
     * Show the dependency visualization panel
     */
    public async show(analysisResult: AnalysisResult): Promise<void> {
        try {
            // Create or reveal the webview panel
            if (this.panel) {
                this.panel.reveal(vscode.ViewColumn.One);
            } else {
                this.panel = vscode.window.createWebviewPanel(
                    'csharpDependencyGraph',
                    'C# Dependency Graph',
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );

                // Handle when the panel is disposed
                this.panel.onDidDispose(() => {
                    this.panel = undefined;
                }, null);

                // Handle messages from the webview
                this.panel.webview.onDidReceiveMessage(
                    this.handleWebviewMessage.bind(this),
                    undefined
                );
                
                
            }

            // Store current analysis result
            this.currentAnalysisResult = analysisResult;

            // Generate visualization data
            const visualizationData = this.generateVisualizationData(analysisResult);
            
            // Generate and set HTML content
            const html = this.generateVisualizationHtml(visualizationData, analysisResult);
            this.panel.webview.html = html;

            this.outputChannel.appendLine('Dependency visualization panel opened');

        } catch (error) {
            this.outputChannel.appendLine(`Error opening visualization panel: ${error}`);
            await Utils.showErrorMessage(`Failed to open visualization: ${error}`);
        }
    }

    /**
     * Generate visualization data from analysis results
     */
    private generateVisualizationData(analysisResult: AnalysisResult): GraphVisualizationData {
        
        
        const nodes: Array<{
            id: string;
            label: string;
            namespace?: string;
            isCircular: boolean;
            filePath?: string;
            group: number;
        }> = [];
        
        const edges: Array<{
            from: string;
            to: string;
            isCircular: boolean;
            reasons: string[];
            weight: number;
        }> = [];

        

        // Get all circular dependency nodes
        const circularNodes = new Set<string>();
        for (const circular of analysisResult.circularDependencies) {
            circular.cycle.forEach(node => circularNodes.add(node));
        }
        

        // Create nodes from dependencies
        let groupId = 0;
        const namespaceGroups = new Map<string, number>();
        
        for (const [fullName, dependency] of analysisResult.dependencies) {
            // Assign group based on namespace
            if (!namespaceGroups.has(dependency.namespace)) {
                namespaceGroups.set(dependency.namespace, groupId++);
            }
            
            const isNodeCircular = circularNodes.has(fullName);
            const displayLabel = this.getDisplayLabel(dependency, analysisResult.analysisLevel);
            
            nodes.push({
                id: fullName,
                label: displayLabel,
                namespace: dependency.namespace,
                isCircular: isNodeCircular,
                filePath: dependency.filePath,
                group: namespaceGroups.get(dependency.namespace) || 0
            });
        }

        // Create edges from dependencies (arrows between boxes)
        let circularEdgeCount = 0;
        
        // Create a Set of all node IDs for validation
        const nodeIds = new Set(nodes.map(node => node.id));
        
        for (const [fromName, dependency] of analysisResult.dependencies) {
            for (const toName of dependency.dependencies) {
                // Check if both boxes exist in our visualization
                const fromExists = nodeIds.has(fromName);
                const toExists = nodeIds.has(toName);
                
                if (!fromExists || !toExists) {
                    continue; // Skip arrows to/from non-existent boxes
                }
                
                const isCircular = this.isEdgeCircular(fromName, toName, analysisResult.circularDependencies);
                const detail = dependency.dependencyDetails.find(d => d.target === toName);
                
                if (isCircular) {
                    circularEdgeCount++;
                }
                
                edges.push({
                    from: fromName,
                    to: toName,
                    isCircular,
                    reasons: detail?.reasons || ['Unknown dependency'],
                    weight: detail?.reasons.length || 1
                });
            }
        }

        return {
            nodes,
            edges,
            circular: analysisResult.circularDependencies.length > 0
        };
    }

    /**
     * Get display label based on analysis level
     */
    private getDisplayLabel(dependency: DependencyNode, level: string): string {
        switch (level) {
            case 'namespace':
                return dependency.namespace;
            case 'class':
                return dependency.name;
            case 'system':
                return dependency.name;
            default:
                return dependency.name;
        }
    }

    /**
     * Check if an edge is part of circular dependencies
     */
    private isEdgeCircular(from: string, to: string, circularDependencies: CircularDependency[]): boolean {
        for (const circular of circularDependencies) {
            for (const edge of circular.edges) {
                if (edge.from === from && edge.to === to) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Generate HTML content for the visualization panel
     */
    private generateVisualizationHtml(data: GraphVisualizationData, analysisResult: AnalysisResult): string {
        const config = this.configManager.getConfig();
        
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>C# Dependency Graph</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding: 10px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .title {
            font-size: 24px;
            font-weight: bold;
        }
        
        .stats {
            display: flex;
            gap: 20px;
            font-size: 14px;
        }
        
        .stat {
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        
        .stat-value {
            font-size: 18px;
            font-weight: bold;
        }
        
        .stat-label {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        
        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            align-items: center;
        }
        
        .btn {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        #graph-container {
            width: 100%;
            height: 600px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            position: relative;
        }
        
        #graph {
            width: 100%;
            height: 100%;
        }
        
        .legend {
            margin-top: 20px;
            padding: 15px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
        }
        
        .legend-title {
            font-weight: bold;
            margin-bottom: 10px;
        }
        
        .legend-items {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .legend-color {
            width: 16px;
            height: 16px;
            border-radius: 50%;
        }
        
        .circular-deps {
            margin-top: 20px;
            padding: 15px;
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 4px;
        }
        
        .circular-deps-title {
            font-weight: bold;
            margin-bottom: 10px;
            color: var(--vscode-inputValidation-warningForeground);
        }
        
        .circular-cycle {
            margin: 8px 0;
            font-family: monospace;
            background: var(--vscode-editor-background);
            padding: 8px;
            border-radius: 3px;
            font-size: 13px;
        }
        
        .error-message {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
        }
    </style>
    <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
</head>
<body>
    <div class="header">
        <div class="title">🔍 C# Dependency Graph</div>
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${data.nodes.length}</div>
                <div class="stat-label">Nodes</div>
            </div>
            <div class="stat">
                <div class="stat-value">${data.edges.length}</div>
                <div class="stat-label">Dependencies</div>
            </div>
            <div class="stat">
                <div class="stat-value">${analysisResult.circularDependencies.length}</div>
                <div class="stat-label">Circular</div>
            </div>
            <div class="stat">
                <div class="stat-value">${config.level}</div>
                <div class="stat-label">Level</div>
            </div>
        </div>
    </div>
    
    <div class="controls">
        <label>Analysis Level:</label>
        <select id="analysisLevel" onchange="changeAnalysisLevel(this.value)" style="margin-right: 15px; padding: 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);">
            <option value="namespace" ${analysisResult.analysisLevel === 'namespace' ? 'selected' : ''}>Namespace Level</option>
            <option value="class" ${analysisResult.analysisLevel === 'class' ? 'selected' : ''}>Class Level</option>
            <option value="system" ${analysisResult.analysisLevel === 'system' ? 'selected' : ''}>System Level</option>
        </select>
        
        <span style="margin: 0 10px;">|</span>
        <button class="btn active" onclick="toggleLayout('hierarchical')">Hierarchical</button>
        <button class="btn" onclick="toggleLayout('force')">Force Directed</button>
        <button class="btn" onclick="toggleLayout('circular')">Circular</button>
        <button class="btn" onclick="highlightCircular()">Highlight Circular</button>
        <button class="btn" onclick="exportDot()">Export DOT</button>
        <button class="btn" onclick="fitGraph()">Fit to Screen</button>
    </div>
    
    <div id="graph-container">
        <div id="graph"></div>
    </div>
    
    <div class="legend">
        <div class="legend-title">Legend:</div>
        <div class="legend-items">
            <div class="legend-item">
                <div class="legend-color" style="background-color: #4CAF50;"></div>
                <span>Normal Dependencies</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #f44336;"></div>
                <span>Circular Dependencies</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #FF9800;"></div>
                <span>Nodes in Circular Dependencies</span>
            </div>
        </div>
    </div>
    
    ${analysisResult.circularDependencies.length > 0 ? this.generateCircularDependenciesHtml(analysisResult.circularDependencies) : ''}
    
    <script>
        // Graph data
        const nodes = new vis.DataSet(${JSON.stringify(data.nodes.map(node => ({
            id: node.id,
            label: node.label,
            color: {
                background: node.isCircular ? '#FF9800' : '#4CAF50',
                border: node.isCircular ? '#F57C00' : '#388E3C'
            },
            font: {
                color: '#000000',
                size: 14,
                face: 'arial'
            },
            title: `<strong>${node.label}</strong><br>Namespace: ${node.namespace || 'Global'}${node.filePath ? '<br>File: ' + node.filePath : ''}${node.isCircular ? '<br><span style="color: #f44336;">⚠️ Part of circular dependency</span>' : ''}<br><em>Double-click to open file</em>`,
            group: node.group
        })))});
        
        const edges = new vis.DataSet(${JSON.stringify(data.edges.map(edge => ({
            from: edge.from,
            to: edge.to,
            color: {
                color: edge.isCircular ? '#f44336' : '#4CAF50'
            },
            width: Math.min(edge.weight, 5),
            arrows: 'to',
            title: edge.reasons.join('\\n')
        })))});
        
        // Network options
        const options = {
            physics: {
                enabled: true,
                stabilization: {iterations: 100}
            },
            layout: {
                hierarchical: {
                    enabled: true,
                    direction: 'UD',
                    sortMethod: 'directed',
                    levelSeparation: 100,
                    nodeSpacing: 100
                }
            },
            nodes: {
                shape: 'box',
                margin: 10,
                font: {
                    size: 14
                }
            },
            edges: {
                smooth: {
                    type: 'curvedCW',
                    roundness: 0.2
                }
            },
            interaction: {
                hover: true,
                tooltipDelay: 200
            }
        };
        
        // Create network
        const container = document.getElementById('graph');
        const network = new vis.Network(container, {nodes: nodes, edges: edges}, options);
        
        // Layout functions
        let currentLayout = 'hierarchical';
        
        function toggleLayout(layoutType) {
            // Update button states
            document.querySelectorAll('.controls .btn').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
            
            currentLayout = layoutType;
            
            const newOptions = {...options};
            
            switch(layoutType) {
                case 'hierarchical':
                    newOptions.layout = {
                        hierarchical: {
                            enabled: true,
                            direction: 'UD',
                            sortMethod: 'directed',
                            levelSeparation: 100,
                            nodeSpacing: 100
                        }
                    };
                    newOptions.physics = {
                        enabled: false
                    };
                    break;
                case 'force':
                    newOptions.layout = {
                        hierarchical: {
                            enabled: false
                        }
                    };
                    newOptions.physics = {
                        enabled: true,
                        barnesHut: {
                            gravitationalConstant: -8000,
                            springLength: 200,
                            springConstant: 0.05
                        }
                    };
                    break;
                case 'circular':
                    newOptions.layout = {
                        hierarchical: {
                            enabled: false
                        }
                    };
                    newOptions.physics = {
                        enabled: false
                    };
                    // Position nodes in a circle
                    const nodeArray = nodes.get();
                    const radius = Math.min(container.offsetWidth, container.offsetHeight) / 3;
                    const angleStep = (2 * Math.PI) / nodeArray.length;
                    
                    nodeArray.forEach((node, index) => {
                        const angle = index * angleStep;
                        node.x = radius * Math.cos(angle);
                        node.y = radius * Math.sin(angle);
                    });
                    
                    nodes.update(nodeArray);
                    break;
            }
            
            network.setOptions(newOptions);
        }
        
        function highlightCircular() {
            const circularNodes = nodes.get().filter(node => node.color.background === '#FF9800');
            const circularEdges = edges.get().filter(edge => edge.color.color === '#f44336');
            
            if (circularNodes.length > 0 || circularEdges.length > 0) {
                network.selectNodes(circularNodes.map(n => n.id));
                network.selectEdges(circularEdges.map(e => e.id));
                network.fit({
                    nodes: circularNodes.map(n => n.id),
                    animation: {
                        duration: 1000,
                        easingFunction: 'easeInOutCubic'
                    }
                });
            }
        }
        
        function exportDot() {
            const dotContent = generateDotFormat();
            const vscode = acquireVsCodeApi();
            vscode.postMessage({
                command: 'exportDot',
                content: dotContent
            });
        }
        
        function fitGraph() {
            network.fit({
                animation: {
                    duration: 1000,
                    easingFunction: 'easeInOutCubic'
                }
            });
        }
        
        function generateDotFormat() {
            const nodeArray = nodes.get();
            const edgeArray = edges.get();
            
            let dot = 'digraph Dependencies {\\\\n';
            dot += '  rankdir=TB;\\\\n';
            dot += '  node [shape=box, style=filled];\\\\n';
            dot += '  edge [fontsize=8];\\\\n\\\\n';
            
            // Add nodes
            nodeArray.forEach(node => {
                const color = node.color.background === '#FF9800' ? 'lightcoral' : 'lightgreen';
                dot += '  "' + node.id + '" [fillcolor=' + color + '];\\n';
            });
            
            dot += '\\n';
            
            // Add edges
            edgeArray.forEach(edge => {
                const color = edge.color.color === '#f44336' ? 'red' : 'darkgreen';
                dot += '  "' + edge.from + '" -> "' + edge.to + '" [color=' + color + '];\\n';
            });
            
            dot += '}';
            return dot;
        }
        
        // Handle node clicks
        network.on('click', function(properties) {
            if (properties.nodes.length > 0) {
                const nodeId = properties.nodes[0];
                const vscode = acquireVsCodeApi();
                vscode.postMessage({
                    command: 'nodeClicked',
                    nodeId: nodeId
                });
            }
        });
        
        // Handle double clicks to open files
        network.on('doubleClick', function(properties) {
            if (properties.nodes.length > 0) {
                const nodeId = properties.nodes[0];
                const vscode = acquireVsCodeApi();
                vscode.postMessage({
                    command: 'openFile',
                    nodeId: nodeId
                });
            }
        });
        
        // Analysis level functions
        function changeAnalysisLevel(newLevel) {
            const vscode = acquireVsCodeApi();
            vscode.postMessage({
                command: 'changeAnalysisLevel',
                level: newLevel
            });
        }
        
        

        // Handle messages from VSCode extension
        // Removed dynamic message handler - using full refresh approach

        // Removed problematic updateVisualizationData function - using full refresh approach
        
        // Initialize with hierarchical layout
        window.addEventListener('load', function() {
            network.stabilize();
            setTimeout(() => {
                network.fit();
            }, 1000);
        });
    </script>
</body>
</html>`;
    }

    /**
     * Generate tooltip content for a node
     */
    private generateNodeTooltip(node: any): string {
        const lines = [
            `<strong>${node.label}</strong>`,
            `<br>`,
            `Namespace: ${node.namespace || 'Global'}`,
        ];
        
        if (node.filePath) {
            lines.push(`File: ${Utils.getRelativePath(node.filePath)}`);
        }
        
        if (node.isCircular) {
            lines.push(`<br><span style="color: #f44336;">⚠️ Part of circular dependency</span>`);
        }
        
        lines.push(`<br><em>Double-click to open file</em>`);
        
        return lines.join('');
    }

    /**
     * Generate HTML for circular dependencies section
     */
    private generateCircularDependenciesHtml(circularDependencies: CircularDependency[]): string {
        let html = `
    <div class="circular-deps">
        <div class="circular-deps-title">⚠️ Circular Dependencies Detected (${circularDependencies.length}):</div>`;
        
        circularDependencies.forEach((circular, index) => {
            const cycleDisplay = circular.cycle.join(' → ');
            const isNew = circular.isNew ? ' <strong>(NEW)</strong>' : '';
            html += `<div class="circular-cycle">${index + 1}. ${cycleDisplay}${isNew}</div>`;
        });
        
        html += `</div>`;
        return html;
    }

    /**
     * Handle messages from the webview
     */
    private async handleWebviewMessage(message: any): Promise<void> {
        
        
        switch (message.command) {
            case 'exportDot':
                await this.exportDotFormat(message.content);
                break;
            case 'nodeClicked':
                await this.handleNodeClick(message.nodeId);
                break;
            case 'openFile':
                await this.openNodeFile(message.nodeId);
                break;
            case 'changeAnalysisLevel':
                await this.handleAnalysisLevelChange(message.level);
                break;
            
            default:
                this.outputChannel.appendLine(`Unknown webview command: ${message.command}`);
                break;
        }
    }

    /**
     * Export DOT format to file
     */
    private async exportDotFormat(dotContent: string): Promise<void> {
        try {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('dependency-graph.dot'),
                filters: {
                    'DOT Files': ['dot'],
                    'All Files': ['*']
                }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(dotContent));
                await Utils.showInfoMessage(`DOT file exported to ${uri.fsPath}`);
                this.outputChannel.appendLine(`DOT format exported to: ${uri.fsPath}`);
            }
        } catch (error) {
            await Utils.showErrorMessage(`Failed to export DOT file: ${error}`);
        }
    }

    /**
     * Handle node click events
     */
    private async handleNodeClick(nodeId: string): Promise<void> {
        this.outputChannel.appendLine(`Node clicked: ${nodeId}`);
        // Could show additional info about the node
    }

    /**
     * Open file associated with a node
     */
    private async openNodeFile(nodeId: string): Promise<void> {
        try {
            // For now, we'll show info about the node
            // In a real implementation, you'd track which file contains each node
            await Utils.showInfoMessage(`Opening file for: ${nodeId}\n(File opening implementation would go here)`);
            this.outputChannel.appendLine(`Request to open file for node: ${nodeId}`);
        } catch (error) {
            await Utils.showErrorMessage(`Failed to open file: ${error}`);
        }
    }

    /**
     * Handle analysis level change
     */
    private async handleAnalysisLevelChange(newLevel: string): Promise<void> {
        try {
            
            
            const cachedResult = await this.cacheManager.getCachedAnalysis(newLevel as AnalysisLevel);
            
            if (cachedResult) {
                // Use cached data - immediate update
                // CRITICAL FIX: Always run circular dependency detection on cached data
                const detector = new CircularDependencyDetector();
                const circularDependencies = detector.findCircularDependencies(cachedResult.dependencies);
                cachedResult.circularDependencies = circularDependencies;
                
                await this.refreshVisualizationWithData(cachedResult);
                
                // Update configuration after successful switch
                await this.configManager.updateConfig('analysisLevel', newLevel);
            } else {
                // No cache available - trigger fresh analysis
                // Update configuration first
                await this.configManager.updateConfig('analysisLevel', newLevel);
                
                // Trigger re-analysis
                await vscode.commands.executeCommand('csharpDependencyMonitor.analyzeProject');
            }
            
        } catch (error) {
            await Utils.showErrorMessage(`Failed to change analysis level: ${error}`);
            
        }
    }

    

    /**
     * Dispose of the visualization panel
     */
    public dispose(): void {
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
    }

    /**
     * Check if the visualization panel is currently open
     */
    public isOpen(): boolean {
        return this.panel !== undefined;
    }

    /**
     * Refresh the visualization with new data WITHOUT switching focus
     */
    public async refresh(analysisResult: AnalysisResult): Promise<void> {
        if (this.panel) {
            // Update data without revealing/focusing the panel
            await this.refreshVisualizationWithData(analysisResult);
        }
    }

    /**
     * Refresh the visualization with new data using full panel refresh WITHOUT focus switching
     */
    private async refreshVisualizationWithData(analysisResult: AnalysisResult): Promise<void> {
        if (!this.panel) {
            // Panel not open, just store the data
            this.currentAnalysisResult = analysisResult;
            return;
        }

        try {
            // Store current analysis result
            this.currentAnalysisResult = analysisResult;

            // Generate visualization data
            const visualizationData = this.generateVisualizationData(analysisResult);
            
            // Generate and set HTML content WITHOUT calling reveal()
            const html = this.generateVisualizationHtml(visualizationData, analysisResult);
            this.panel.webview.html = html;

            this.outputChannel.appendLine('Dependency visualization panel updated silently');
            
        } catch (error) {
            this.outputChannel.appendLine(`Failed to update visualization: ${error}`);
            await Utils.showErrorMessage(`Failed to update visualization: ${error}`);
        }
    }
}