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
            isDirectCircular?: boolean;
            isChainCircular?: boolean;
            filePath?: string;
            group: number;
            classType?: 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
        }> = [];
        
        const edges: Array<{
            from: string;
            to: string;
            isCircular: boolean;
            reasons: string[];
            weight: number;
        }> = [];

        

        // Enhanced circular dependency coloring: immediate vs chain
        const circularNodes = new Set<string>();
        const directCircularNodes = new Set<string>(); // A -> B -> A (red)
        const chainCircularNodes = new Set<string>(); // A -> B -> C -> ... -> A (yellow for C+)
        
        for (const circular of analysisResult.circularDependencies) {
            circular.cycle.forEach(node => circularNodes.add(node));
            
            if (circular.cycle.length === 2) {
                // Direct circular: A -> B -> A
                circular.cycle.forEach(node => directCircularNodes.add(node));
            } else if (circular.cycle.length > 2) {
                // Chain circular: A -> B -> C -> ... -> A
                // First two nodes are red (immediate dependency)
                directCircularNodes.add(circular.cycle[0]);
                directCircularNodes.add(circular.cycle[1]);
                // Rest are yellow (chain dependencies)
                for (let i = 2; i < circular.cycle.length; i++) {
                    chainCircularNodes.add(circular.cycle[i]);
                }
            }
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
            const isDirectCircular = directCircularNodes.has(fullName);
            const isChainCircular = chainCircularNodes.has(fullName);
            const displayLabel = this.getDisplayLabel(dependency, analysisResult.analysisLevel);
            
            nodes.push({
                id: fullName,
                label: displayLabel,
                namespace: dependency.namespace,
                isCircular: isNodeCircular,
                isDirectCircular: isDirectCircular,
                isChainCircular: isChainCircular,
                filePath: dependency.filePath,
                group: namespaceGroups.get(dependency.namespace) || 0,
                classType: dependency.classType
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
            padding: 10px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        }
        
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
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
            flex: 1;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            position: relative;
            min-height: 400px;
        }
        
        #graph {
            width: 100%;
            height: 100%;
        }
        
        .legend {
            margin-bottom: 10px;
            padding: 10px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            flex-shrink: 0;
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
            margin-top: 10px;
            padding: 10px;
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
    <div class="main-content">
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
        <span style="margin: 0 10px;">|</span>
        <button class="btn" onclick="highlightCircular()">Highlight Circular</button>
        <button class="btn" onclick="exportDot()">Export DOT</button>
        <button class="btn" onclick="fitGraph()">Fit to Screen</button>
    </div>
    
    <div class="legend">
        <div class="legend-title">Legend:</div>
        <div class="legend-items" id="legend-items">
            ${config.visualization.namespaceColoring ? `
            <div class="legend-item">
                <div class="legend-color" style="background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57);"></div>
                <span>Namespace-based Colors</span>
            </div>` : `
            <div class="legend-item">
                <div class="legend-color" style="background-color: #4CAF50;"></div>
                <span>Normal Dependencies</span>
            </div>`}
            ${config.visualization.enhancedCircularDeps ? `
            <div class="legend-item">
                <div class="legend-color" style="background-color: #f44336;"></div>
                <span>Direct Circular Dependencies (A→B→A)</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #ffeb3b;"></div>
                <span>Chain Circular Dependencies (A→B→C→A, C+ nodes)</span>
            </div>` : `
            <div class="legend-item">
                <div class="legend-color" style="background-color: #f44336;"></div>
                <span>Circular Dependencies</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #FF9800;"></div>
                <span>Nodes in Circular Dependencies</span>
            </div>`}
            ${config.visualization.namespaceGrouping ? `
            <div class="legend-item">
                <div class="legend-color" style="background: linear-gradient(45deg, rgba(255,107,107,0.4), rgba(78,205,196,0.4), rgba(69,183,209,0.4)); border: 2px solid #333;"></div>
                <span>Namespace Visual Grouping (nodes positioned by namespace)</span>
            </div>` : ''}
        </div>
    </div>
    
    <div id="graph-container">
        <div id="graph"></div>
    </div>
    
    ${analysisResult.circularDependencies.length > 0 ? this.generateCircularDependenciesHtml(analysisResult.circularDependencies) : ''}
    </div>
    
    <script>
        // Safely acquire VS Code API (only once per session)
        let vscode;
        try {
            vscode = acquireVsCodeApi();
        } catch (error) {
            // API already acquired, try to get the existing instance
            if (window.vscode) {
                vscode = window.vscode;
            } else {
                console.error('Cannot acquire VS Code API:', error);
                vscode = null;
            }
        }
        
        // Store it globally for reuse
        if (vscode) {
            window.vscode = vscode;
        }
        
        // Graph data
        // Configuration for visualization features
        const vizConfig = ${JSON.stringify(config.visualization)};
        console.log('🎨 Visualization config:', vizConfig);
        
        // Function to convert HSL to Hex
        function hslToHex(h, s, l) {
            l /= 100;
            const a = s * Math.min(l, 1 - l) / 100;
            const f = n => {
                const k = (n + h / 30) % 12;
                const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
                return Math.round(255 * color).toString(16).padStart(2, '0');
            };
            return \`#\${f(0)}\${f(8)}\${f(4)}\`;
        }
        
        // Function to calculate luminance of a color for text contrast
        function getLuminance(hexColor) {
            // Convert hex to RGB
            const hex = hexColor.replace('#', '');
            const r = parseInt(hex.substr(0, 2), 16) / 255;
            const g = parseInt(hex.substr(2, 2), 16) / 255;
            const b = parseInt(hex.substr(4, 2), 16) / 255;
            
            // Apply gamma correction
            const rLinear = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
            const gLinear = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
            const bLinear = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
            
            // Calculate luminance
            return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
        }
        
        // Function to get optimal text color based on background
        function getTextColor(backgroundColor, colorScheme) {
            const luminance = getLuminance(backgroundColor);
            
            // For high-contrast mode, use maximum contrast
            if (colorScheme === 'high-contrast') {
                return luminance > 0.5 ? '#000000' : '#FFFFFF'; // Pure black or white
            }
            
            // For colorblind mode, use colorblind-safe text colors
            if (colorScheme === 'colorblind') {
                // Use slightly softer contrast for better reading
                return luminance > 0.4 ? '#1A1A1A' : '#F0F0F0'; // Dark grey or light grey
            }
            
            // For default, use standard contrast calculation
            return luminance > 0.35 ? '#333333' : '#FFFFFF'; // Dark grey or white
        }

        // Function to generate namespace-based colors
        function getNamespaceColor(namespace, colorScheme) {
            // Enhanced color schemes for better accessibility and visibility
            if (colorScheme === 'colorblind') {
                // Use improved Paul Tol's colorblind-safe palette with optimal text colors
                const colorblindPalette = [
                    { background: '#EE7733', border: '#B85500', text: '#1A1A1A' }, // Orange - dark text
                    { background: '#0077BB', border: '#004C80', text: '#F0F0F0' }, // Blue - light text
                    { background: '#33BBEE', border: '#1199CC', text: '#1A1A1A' }, // Light Blue - dark text
                    { background: '#EE3377', border: '#BB1155', text: '#1A1A1A' }, // Pink - dark text
                    { background: '#CC3311', border: '#992200', text: '#F0F0F0' }, // Red - light text
                    { background: '#009988', border: '#006655', text: '#F0F0F0' }, // Teal - light text
                    { background: '#BBBBBB', border: '#888888', text: '#1A1A1A' }, // Light Grey - dark text
                    { background: '#332288', border: '#221166', text: '#F0F0F0' }, // Dark Purple - light text
                    { background: '#AA4499', border: '#882277', text: '#F0F0F0' }, // Mauve - light text
                    { background: '#88CCEE', border: '#55AACC', text: '#1A1A1A' }, // Pale Blue - dark text
                    { background: '#FFAABB', border: '#CC7788', text: '#1A1A1A' }, // Pale Pink - dark text
                    { background: '#99DDFF', border: '#66AACC', text: '#1A1A1A' }  // Sky Blue - dark text
                ];
                
                // Better hash distribution to prevent collisions
                let hash = 0;
                for (let i = 0; i < namespace.length; i++) {
                    const char = namespace.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32-bit integer
                }
                
                // Use a better distribution method
                const index = Math.abs(hash) % colorblindPalette.length;
                console.log('🎨 Colorblind - Namespace:', namespace, 'Hash:', hash, 'Index:', index, 'Color:', colorblindPalette[index]);
                return colorblindPalette[index];
            } else if (colorScheme === 'high-contrast') {
                // High contrast colors with MAXIMUM differentiation and optimal text contrast
                const highContrastPalette = [
                    { background: '#0000FF', border: '#000099', text: '#FFFFFF' }, // Pure Blue - white text
                    { background: '#FF0000', border: '#CC0000', text: '#FFFFFF' }, // Pure Red - white text
                    { background: '#00CC00', border: '#009900', text: '#000000' }, // Pure Green - black text
                    { background: '#FFAA00', border: '#CC8800', text: '#000000' }, // Pure Orange - black text
                    { background: '#AA00AA', border: '#880088', text: '#FFFFFF' }, // Pure Magenta - white text
                    { background: '#00AAAA', border: '#008888', text: '#000000' }, // Pure Cyan - black text
                    { background: '#CCCC00', border: '#999900', text: '#000000' }, // Pure Yellow - black text
                    { background: '#6600CC', border: '#4400AA', text: '#FFFFFF' }, // Pure Purple - white text
                    { background: '#FF6600', border: '#CC4400', text: '#000000' }, // Red-Orange - black text
                    { background: '#0066CC', border: '#004499', text: '#FFFFFF' }, // Dark Blue - white text
                    { background: '#CC0066', border: '#990044', text: '#FFFFFF' }, // Deep Pink - white text
                    { background: '#66CC00', border: '#449900', text: '#000000' }  // Lime Green - black text
                ];
                
                // Same improved hash distribution
                let hash = 0;
                for (let i = 0; i < namespace.length; i++) {
                    const char = namespace.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32-bit integer
                }
                
                const index = Math.abs(hash) % highContrastPalette.length;
                console.log('🎨 High-contrast - Namespace:', namespace, 'Hash:', hash, 'Index:', index, 'Color:', highContrastPalette[index]);
                return highContrastPalette[index];
            } else {
                // Default scheme using HSL for smooth color variations
                const scheme = { saturation: 70, lightness: 50 };
                
                // Generate consistent hue for namespace with better distribution
                let hash = 0;
                for (let i = 0; i < namespace.length; i++) {
                    const char = namespace.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32-bit integer
                }
                
                // Use golden ratio for better distribution
                const goldenRatio = 0.618033988749;
                const hue = Math.floor((Math.abs(hash) * goldenRatio) % 360);
                
                const background = \`hsl(\${hue}, \${scheme.saturation}%, \${scheme.lightness}%)\`;
                const border = \`hsl(\${hue}, \${scheme.saturation}%, \${scheme.lightness - 15}%)\`;
                // Convert HSL to hex for text color calculation
                const hexBackground = hslToHex(hue, scheme.saturation, scheme.lightness);
                const text = getTextColor(hexBackground, colorScheme);
                
                console.log('🎨 Default - Namespace:', namespace, 'Hash:', hash, 'Hue:', hue, 'Color:', { background, border, text });
                return { background, border, text };
            }
        }
        
        // Function to generate type-based colors
        function getTypeBasedColor(classType, colorScheme) {
            if (!classType) {
                return {
                    background: '#4CAF50',
                    border: '#388E3C',
                    text: getTextColor('#4CAF50', colorScheme)
                }; // Default green
            }
            
            const typeColors = {
                default: {
                    'class': { background: '#2196F3', border: '#1976D2', text: '#FFFFFF' },      // Blue
                    'struct': { background: '#FF9800', border: '#F57C00', text: '#1A1A1A' },     // Orange
                    'interface': { background: '#9C27B0', border: '#7B1FA2', text: '#FFFFFF' }, // Purple
                    'enum': { background: '#4CAF50', border: '#388E3C', text: '#FFFFFF' },       // Green
                    'record': { background: '#00BCD4', border: '#0097A7', text: '#1A1A1A' },     // Cyan
                    'record struct': { background: '#FF5722', border: '#D84315', text: '#FFFFFF' }, // Deep Orange
                    'delegate': { background: '#795548', border: '#5D4037', text: '#FFFFFF' }     // Brown
                },
                colorblind: {
                    'class': { background: '#0077BB', border: '#004C80', text: '#F0F0F0' },      // Blue
                    'struct': { background: '#EE7733', border: '#CC5500', text: '#1A1A1A' },     // Orange
                    'interface': { background: '#CC3311', border: '#AA1100', text: '#F0F0F0' }, // Red
                    'enum': { background: '#009988', border: '#007766', text: '#F0F0F0' },       // Teal
                    'record': { background: '#33BBEE', border: '#1199CC', text: '#1A1A1A' },     // Light Blue
                    'record struct': { background: '#EE3377', border: '#CC1155', text: '#1A1A1A' }, // Pink
                    'delegate': { background: '#BBBBBB', border: '#999999', text: '#1A1A1A' }     // Gray
                },
                'high-contrast': {
                    'class': { background: '#0000FF', border: '#000080', text: '#FFFFFF' },      // Bright Blue
                    'struct': { background: '#FF8000', border: '#CC6600', text: '#000000' },     // Bright Orange
                    'interface': { background: '#8000FF', border: '#6600CC', text: '#FFFFFF' }, // Bright Purple
                    'enum': { background: '#00FF00', border: '#00CC00', text: '#000000' },       // Bright Green
                    'record': { background: '#00FFFF', border: '#00CCCC', text: '#000000' },     // Bright Cyan
                    'record struct': { background: '#FF4000', border: '#CC3300', text: '#FFFFFF' }, // Bright Red-Orange
                    'delegate': { background: '#808080', border: '#606060', text: '#FFFFFF' }     // Gray
                }
            };
            
            const scheme = typeColors[colorScheme] || typeColors.default;
            const color = scheme[classType] || { background: '#4CAF50', border: '#388E3C' };
            
            // Ensure text color is set
            if (!color.text) {
                color.text = getTextColor(color.background, colorScheme);
            }
            
            return color;
        }
        
        // Process nodes with type-based and namespace coloring
        console.log('🎨 Processing nodes with config:', vizConfig);
        const rawNodesData = ${JSON.stringify(data.nodes)};
        console.log('🎨 Sample nodes with classType:', rawNodesData.slice(0, 5).map(n => ({id: n.id, classType: n.classType})));
        
        const processedNodes = rawNodesData.map(node => {
            console.log('🎨 Processing node:', node.id, 'classType:', node.classType);
            let nodeColor = {
                background: '#4CAF50',
                border: '#388E3C'
            };
            
            // Priority: Enhanced Circular > Type-based > Namespace-based > Default
            if (node.isCircular) {
                // Enhanced circular dependency coloring
                if (vizConfig.enhancedCircularDeps) {
                    if (node.isDirectCircular) {
                        // Direct circular dependencies: Red
                        nodeColor = {
                            background: '#f44336',
                            border: '#d32f2f',
                            text: getTextColor('#f44336', vizConfig.colorScheme)
                        };
                        console.log('🎨 Applied direct circular color (red) for', node.id);
                    } else if (node.isChainCircular) {
                        // Chain circular dependencies: Yellow
                        nodeColor = {
                            background: '#ffeb3b',
                            border: '#fbc02d',
                            text: getTextColor('#ffeb3b', vizConfig.colorScheme)
                        };
                        console.log('🎨 Applied chain circular color (yellow) for', node.id);
                    } else {
                        // Fallback for other circular nodes: Orange
                        nodeColor = {
                            background: '#FF9800',
                            border: '#F57C00',
                            text: getTextColor('#FF9800', vizConfig.colorScheme)
                        };
                        console.log('🎨 Applied fallback circular color (orange) for', node.id);
                    }
                } else {
                    // Traditional circular dependency coloring: Orange
                    nodeColor = {
                        background: '#FF9800',
                        border: '#F57C00',
                        text: getTextColor('#FF9800', vizConfig.colorScheme)
                    };
                    console.log('🎨 Applied traditional circular color (orange) for', node.id);
                }
            } else {
                // Non-circular nodes: apply other coloring rules
                // Priority: Type-based > Namespace-based > Default
                if (vizConfig.typeBasedColoring && node.classType) {
                    const typeColor = getTypeBasedColor(node.classType, vizConfig.colorScheme);
                    nodeColor = typeColor;
                    console.log('🎨 Applied type color for', node.id, 'type:', node.classType, 'scheme:', vizConfig.colorScheme);
                } else if (vizConfig.namespaceColoring && node.namespace) {
                    const namespaceColor = getNamespaceColor(node.namespace, vizConfig.colorScheme);
                    nodeColor = namespaceColor;
                    console.log('🎨 Applied namespace color for', node.namespace, 'scheme:', vizConfig.colorScheme, 'color:', namespaceColor);
                } else {
                    // Default color with proper text color
                    nodeColor = {
                        background: '#4CAF50',
                        border: '#388E3C',
                        text: getTextColor('#4CAF50', vizConfig.colorScheme)
                    };
                }
            }
            
            // Apply namespace grouping if enabled (visual positioning only)
            let nodeGroup = node.group;
            if (vizConfig.namespaceGrouping && node.namespace) {
                nodeGroup = node.namespace;
                console.log('🎨 Applied group', node.namespace, 'to node', node.id);
            }
            
            return {
                id: node.id,
                label: node.label,
                color: nodeColor,
                font: {
                    color: nodeColor.text, // Use calculated text color
                    size: 14,
                    face: 'arial'
                },
                title: \`<strong>\${node.label}</strong><br>Type: \${node.classType || 'Unknown'}<br>Namespace: \${node.namespace || 'Global'}\${node.filePath ? '<br>File: ' + node.filePath : ''}\${node.isCircular ? '<br><span style="color: #f44336;">⚠️ Part of circular dependency</span>' : ''}<br>\`,
                group: nodeGroup
            };
        });
        
        const nodes = new vis.DataSet(processedNodes);
        
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
                tooltipDelay: 200,
                selectConnectedEdges: false,
                hoverConnectedEdges: false,
                zoomView: true,
                dragView: true,
                dragNodes: true,
                keyboard: {
                    enabled: false
                }
            }
        };
        
        // Apply namespace-based visual grouping if enabled
        if (vizConfig.namespaceGrouping) {
            console.log('🎨 Enabling namespace visual grouping with stronger positioning');
            
            // Disable physics completely for better control over positioning
            options.physics = {
                enabled: false
            };
            
            // Disable hierarchical layout
            options.layout = {
                hierarchical: {
                    enabled: false
                },
                randomSeed: 42
            };
            
            console.log('🎨 Configured namespace visual grouping with manual positioning');
        }
        
        // Create network
        const container = document.getElementById('graph');
        
        // Apply namespace visual grouping with manual positioning
        if (vizConfig.namespaceGrouping) {
            console.log('🎨 Applying namespace visual grouping with manual positioning');
            
            // Calculate positions for each namespace group BEFORE creating network
            const namespaces = new Set();
            processedNodes.forEach(node => {
                if (node.group && typeof node.group === 'string') {
                    namespaces.add(node.group);
                }
            });
            
            const namespacesArray = Array.from(namespaces);
            
            // Calculate MUCH MORE dynamic sizing based on node count per namespace
            const namespaceSizes = new Map();
            const namespacePadding = new Map();
            
            namespacesArray.forEach(namespace => {
                const nodeCount = processedNodes.filter(node => node.group === namespace).length;
                
                // Much more aggressive scaling for visual distinction
                let radius, padding;
                if (nodeCount === 1) {
                    radius = 60;
                    padding = 40;
                } else if (nodeCount <= 3) {
                    radius = 120;
                    padding = 60;
                } else if (nodeCount <= 6) {
                    radius = 200;
                    padding = 80;
                } else if (nodeCount <= 12) {
                    radius = 300;
                    padding = 100;
                } else if (nodeCount <= 20) {
                    radius = 450;
                    padding = 130;
                } else {
                    // Large namespaces like Combat (23+ nodes)
                    radius = 600 + (nodeCount - 20) * 15;
                    padding = 150 + (nodeCount - 20) * 5;
                }
                
                namespaceSizes.set(namespace, radius);
                namespacePadding.set(namespace, padding);
                console.log('🎨 Namespace', namespace, 'has', nodeCount, 'nodes → radius:', radius, 'padding:', padding);
            });
            
            // Sort namespaces by size (largest first for better layout)
            const sortedNamespaces = namespacesArray.sort((a, b) => {
                const sizeA = namespaceSizes.get(a);
                const sizeB = namespaceSizes.get(b);
                return sizeB - sizeA; // Largest first
            });
            
            // MUCH MORE dynamic spacing based on actual group sizes
            const groupPositions = new Map();
            const totalGroups = sortedNamespaces.length;
            
            if (totalGroups === 1) {
                // Single group at center
                groupPositions.set(sortedNamespaces[0], {x: 0, y: 0});
            } else if (totalGroups === 2) {
                // Two groups with minimal spacing based on their actual sizes
                const size1 = namespaceSizes.get(sortedNamespaces[0]);
                const size2 = namespaceSizes.get(sortedNamespaces[1]);
                const spacing = size1 + size2 + 80; // Minimal gap between areas
                groupPositions.set(sortedNamespaces[0], {x: -spacing/2, y: 0});
                groupPositions.set(sortedNamespaces[1], {x: spacing/2, y: 0});
            } else {
                // Multiple groups with MUCH more generous spacing
                const cols = Math.min(2, Math.ceil(Math.sqrt(totalGroups))); // Limit to 2 columns for better spacing
                let currentY = 0;
                
                for (let row = 0; row < Math.ceil(totalGroups / cols); row++) {
                    const rowNamespaces = sortedNamespaces.slice(row * cols, (row + 1) * cols);
                    const maxRowRadius = Math.max(...rowNamespaces.map(ns => namespaceSizes.get(ns)));
                    
                    let currentX = 0;
                    if (rowNamespaces.length === 1) {
                        // Center single item in row
                        currentX = 0;
                    } else {
                        // Calculate starting position for multiple items
                        const totalRowWidth = rowNamespaces.reduce((sum, ns, idx) => {
                            const size = namespaceSizes.get(ns);
                            const gap = idx > 0 ? size + namespaceSizes.get(rowNamespaces[idx-1]) + 300 : 0;
                            return sum + gap;
                        }, 0);
                        currentX = -totalRowWidth / 2;
                    }
                    
                    rowNamespaces.forEach((namespace, colIndex) => {
                        const radius = namespaceSizes.get(namespace);
                        groupPositions.set(namespace, {x: currentX, y: currentY});
                        
                        if (colIndex < rowNamespaces.length - 1) {
                            const nextRadius = namespaceSizes.get(rowNamespaces[colIndex + 1]);
                            currentX += radius + nextRadius + 100; // Smaller gap between areas
                        }
                        
                        console.log('🎨 Group', namespace, 'positioned at', {x: groupPositions.get(namespace).x, y: currentY}, 'radius:', radius);
                    });
                    
                    currentY += maxRowRadius * 2 + 120; // Smaller vertical spacing
                }
            }
            
            // Apply positions to nodes BEFORE creating network with dynamic sizing
            sortedNamespaces.forEach(namespace => {
                const nodesInNamespace = processedNodes.filter(node => node.group === namespace);
                const groupCenter = groupPositions.get(namespace);
                const groupRadius = namespaceSizes.get(namespace);
                
                if (nodesInNamespace.length > 0 && groupCenter) {
                    nodesInNamespace.forEach((node, index) => {
                        let nodeX, nodeY;
                        
                        if (nodesInNamespace.length === 1) {
                            // Single node at center
                            nodeX = groupCenter.x;
                            nodeY = groupCenter.y;
                        } else if (nodesInNamespace.length <= 8) {
                            // Small/medium groups: circle layout with generous spacing
                            const nodeAngle = (2 * Math.PI * index) / nodesInNamespace.length;
                            const nodeRadius = Math.min(groupRadius - 80, groupRadius * 0.7);
                            nodeX = groupCenter.x + nodeRadius * Math.cos(nodeAngle);
                            nodeY = groupCenter.y + nodeRadius * Math.sin(nodeAngle);
                        } else {
                            // Large groups: generous grid layout with proper spacing
                            const maxNodesPerRow = Math.min(6, Math.ceil(Math.sqrt(nodesInNamespace.length)));
                            const row = Math.floor(index / maxNodesPerRow);
                            const col = index % maxNodesPerRow;
                            
                            // Much more generous spacing for visibility
                            const nodeSpacing = Math.max(120, groupRadius / maxNodesPerRow);
                            const offsetX = (col - (maxNodesPerRow-1)/2) * nodeSpacing;
                            const totalRows = Math.ceil(nodesInNamespace.length / maxNodesPerRow);
                            const offsetY = (row - (totalRows-1)/2) * nodeSpacing;
                            nodeX = groupCenter.x + offsetX;
                            nodeY = groupCenter.y + offsetY;
                        }
                        
                        // Apply position directly to node data but ALLOW DRAGGING
                        const nodeUpdate = processedNodes.find(n => n.id === node.id);
                        if (nodeUpdate) {
                            nodeUpdate.x = nodeX;
                            nodeUpdate.y = nodeY;
                            nodeUpdate.fixed = false; // Allow dragging!
                            nodeUpdate.physics = false; // Keep physics disabled for positioning
                        }
                    });
                    console.log('🎨 Positioned', nodesInNamespace.length, 'nodes for namespace:', namespace, 'in area with radius:', groupRadius);
                }
            });
            
            // Update nodes dataset with positions
            nodes.update(processedNodes);
        }
        
        const network = new vis.Network(container, {nodes: nodes, edges: edges}, options);
        
        // Add namespace border areas after network is created (BEHIND nodes, border-only)
        if (vizConfig.namespaceGrouping) {
            network.on('beforeDrawing', function(ctx) {
                // Get unique namespaces and their positions
                const namespaces = new Set();
                processedNodes.forEach(node => {
                    if (node.group && typeof node.group === 'string') {
                        namespaces.add(node.group);
                    }
                });
                
                // Draw border rectangles for each namespace (BEHIND nodes)
                Array.from(namespaces).forEach(namespace => {
                    const nodesInNamespace = processedNodes.filter(node => node.group === namespace);
                    if (nodesInNamespace.length > 1) {
                        const namespaceColor = getNamespaceColor(namespace, vizConfig.colorScheme);
                        
                        // Get node positions from network
                        const positions = [];
                        nodesInNamespace.forEach(node => {
                            const pos = network.getPositions([node.id])[node.id];
                            if (pos) {
                                positions.push(pos);
                            }
                        });
                        
                        if (positions.length > 1) {
                            // Calculate bounding box with generous padding
                            const padding = 80;
                            const minX = Math.min(...positions.map(p => p.x)) - padding;
                            const maxX = Math.max(...positions.map(p => p.x)) + padding;
                            const minY = Math.min(...positions.map(p => p.y)) - padding;
                            const maxY = Math.max(...positions.map(p => p.y)) + padding;
                            
                            // Draw ONLY border rectangle (no fill)
                            ctx.save();
                            ctx.strokeStyle = namespaceColor.border; // Use exact namespace border color
                            ctx.lineWidth = 4;
                            ctx.setLineDash([10, 5]); // Dashed border for clear distinction
                            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
                            
                            // Draw namespace label with background for readability
                            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'; // Semi-transparent white background
                            ctx.strokeStyle = namespaceColor.border;
                            ctx.lineWidth = 1;
                            ctx.setLineDash([]); // Reset line dash
                            ctx.font = '14px Arial bold';
                            ctx.textAlign = 'center';
                            
                            const labelX = minX + (maxX - minX) / 2;
                            const labelY = minY - 15;
                            const textWidth = ctx.measureText(namespace).width;
                            
                            // Draw label background
                            ctx.fillRect(labelX - textWidth/2 - 8, labelY - 12, textWidth + 16, 20);
                            ctx.strokeRect(labelX - textWidth/2 - 8, labelY - 12, textWidth + 16, 20);
                            
                            // Draw label text
                            ctx.fillStyle = namespaceColor.border;
                            ctx.fillText(namespace, labelX, labelY);
                            
                            ctx.restore();
                        }
                    }
                });
            });
        }
        
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
            if (vscode) {
                vscode.postMessage({
                    command: 'exportDot',
                    content: dotContent
                });
            }
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
        
        // Track selected nodes for focus mode
        let selectedNodeId = null;
        
        // Handle node clicks
        network.on('click', function(properties) {
            if (properties.nodes.length > 0) {
                const nodeId = properties.nodes[0];
                selectedNodeId = nodeId;
                
                // Apply focus mode if enabled
                if (vizConfig.nodeSelection) {
                    // Always clear focus mode first to ensure clean state
                    clearFocusMode();
                    // Then apply focus mode for the new node
                    applyFocusMode(nodeId);
                }
                
                if (vscode) {
                    vscode.postMessage({
                        command: 'nodeClicked',
                        nodeId: nodeId
                    });
                }
                
                // Prevent event from interfering with other UI controls
                if (properties.event && properties.event.srcEvent) {
                    const target = properties.event.srcEvent.target;
                    const isSelect = target.closest('select');
                    const isButton = target.closest('button');
                    const isControls = target.closest('.controls');
                    
                    if (!isSelect && !isButton && !isControls) {
                        properties.event.srcEvent.stopPropagation();
                    }
                }
            } else {
                // Clicked on empty space - clear selection
                selectedNodeId = null;
                if (vizConfig.nodeSelection) {
                    clearFocusMode();
                }
            }
        });
        
        // Function to apply focus mode (grey out non-connected nodes/edges)
        function applyFocusMode(selectedNodeId) {
            console.log('🎯 Applying focus mode for node:', selectedNodeId);
            
            // Detect VS Code theme (dark vs light)
            const isDarkTheme = document.body.getAttribute('data-vscode-theme-kind') === 'vscode-dark' ||
                              document.body.getAttribute('data-vscode-theme-kind') === 'vscode-high-contrast' ||
                              window.getComputedStyle(document.body).backgroundColor === 'rgb(30, 30, 30)' ||
                              window.getComputedStyle(document.body).backgroundColor === 'rgb(37, 37, 38)';
            
            console.log('🎯 Detected theme - isDark:', isDarkTheme);
            
            // Choose appropriate dimmed colors based on theme
            const dimmedColors = isDarkTheme ? {
                nodeBackground: '#2D2D2D',   // Dark grey for dark themes
                nodeBorder: '#1A1A1A',       // Very dark grey
                nodeText: '#666666',         // Dimmed text
                edgeColor: '#404040'         // Dark grey edges
            } : {
                nodeBackground: '#E0E0E0',   // Light grey for light themes
                nodeBorder: '#CCCCCC',       // Medium grey
                nodeText: '#999999',         // Dimmed text
                edgeColor: '#CCCCCC'         // Light grey edges
            };
            
            // Find directly connected nodes
            const connectedNodeIds = new Set([selectedNodeId]);
            const connectedEdgeIds = new Set();
            
            // Get all edges to/from the selected node
            const allEdges = edges.get();
            allEdges.forEach(edge => {
                if (edge.from === selectedNodeId) {
                    connectedNodeIds.add(edge.to);
                    connectedEdgeIds.add(edge.id);
                } else if (edge.to === selectedNodeId) {
                    connectedNodeIds.add(edge.from);
                    connectedEdgeIds.add(edge.id);
                }
            });
            
            console.log('🎯 Connected nodes:', Array.from(connectedNodeIds));
            console.log('🎯 Connected edges:', Array.from(connectedEdgeIds));
            
            // Update nodes: keep original colors for connected, theme-appropriate grey for others
            const allNodes = nodes.get();
            const updatedNodes = allNodes.map(node => {
                if (connectedNodeIds.has(node.id)) {
                    // Keep original color for connected nodes
                    return node;
                } else {
                    // Grey out unconnected nodes with theme-appropriate colors
                    return {
                        ...node,
                        color: {
                            background: dimmedColors.nodeBackground,
                            border: dimmedColors.nodeBorder
                        },
                        font: {
                            ...node.font,
                            color: dimmedColors.nodeText
                        }
                    };
                }
            });
            
            // Update edges: keep original colors for connected, theme-appropriate grey for others
            const updatedEdges = allEdges.map(edge => {
                if (connectedEdgeIds.has(edge.id)) {
                    // Keep original color for connected edges
                    return edge;
                } else {
                    // Grey out unconnected edges with theme-appropriate color
                    return {
                        ...edge,
                        color: {
                            color: dimmedColors.edgeColor
                        }
                    };
                }
            });
            
            // Apply the updates
            nodes.update(updatedNodes);
            edges.update(updatedEdges);
        }
        
        // Function to clear focus mode (restore original colors)
        function clearFocusMode() {
            console.log('🎯 Clearing focus mode');
            
            // Restore original colors by regenerating nodes and edges
            const originalNodes = rawNodesData.map(node => {
                let nodeColor = {
                    background: '#4CAF50',
                    border: '#388E3C'
                };
                
                // Apply the same coloring logic as in initial generation
                if (node.isCircular) {
                    if (vizConfig.enhancedCircularDeps) {
                        if (node.isDirectCircular) {
                            nodeColor = {
                                background: '#f44336',
                                border: '#d32f2f',
                                text: getTextColor('#f44336', vizConfig.colorScheme)
                            };
                        } else if (node.isChainCircular) {
                            nodeColor = {
                                background: '#ffeb3b',
                                border: '#fbc02d',
                                text: getTextColor('#ffeb3b', vizConfig.colorScheme)
                            };
                        } else {
                            nodeColor = {
                                background: '#FF9800',
                                border: '#F57C00',
                                text: getTextColor('#FF9800', vizConfig.colorScheme)
                            };
                        }
                    } else {
                        nodeColor = {
                            background: '#FF9800',
                            border: '#F57C00',
                            text: getTextColor('#FF9800', vizConfig.colorScheme)
                        };
                    }
                } else {
                    if (vizConfig.typeBasedColoring && node.classType) {
                        nodeColor = getTypeBasedColor(node.classType, vizConfig.colorScheme);
                    } else if (vizConfig.namespaceColoring && node.namespace) {
                        nodeColor = getNamespaceColor(node.namespace, vizConfig.colorScheme);
                    } else {
                        // Default color with proper text color
                        nodeColor = {
                            background: '#4CAF50',
                            border: '#388E3C',
                            text: getTextColor('#4CAF50', vizConfig.colorScheme)
                        };
                    }
                }
                
                return {
                    id: node.id,
                    label: node.label,
                    color: nodeColor,
                    font: {
                        color: nodeColor.text, // Use calculated text color
                        size: 14,
                        face: 'arial'
                    },
                    title: \`<strong>\${node.label}</strong><br>Type: \${node.classType || 'Unknown'}<br>Namespace: \${node.namespace || 'Global'}\${node.filePath ? '<br>File: ' + node.filePath : ''}\${node.isCircular ? '<br><span style="color: #f44336;">⚠️ Part of circular dependency</span>' : ''}<br>\`,
                    group: node.group
                };
            });
            
            // Restore original edge colors
            const originalEdges = ${JSON.stringify(data.edges.map(edge => ({
                from: edge.from,
                to: edge.to,
                color: {
                    color: edge.isCircular ? '#f44336' : '#4CAF50'
                },
                width: Math.min(edge.weight, 5),
                arrows: 'to',
                title: edge.reasons.join('\\n')
            })))};
            
            nodes.update(originalNodes);
            edges.update(originalEdges);
        }
        
        // Handle double clicks to open files or show edge details
        network.on('doubleClick', function(properties) {
            // Check if an edge was double-clicked
            if (properties.edges.length > 0) {
                const edgeId = properties.edges[0];
                const edge = edges.get(edgeId);
                
                if (edge && vscode) {
                    vscode.postMessage({
                        command: 'edgeDoubleClicked',
                        edgeData: {
                            from: edge.from,
                            to: edge.to,
                            reasons: edge.title.split('\\n'), // Convert back from string to array
                            isCircular: edge.color.color === '#f44336',
                            weight: edge.width
                        }
                    });
                }
            }
            // Check if a node was double-clicked
            else if (properties.nodes.length > 0) {
                const nodeId = properties.nodes[0];
                if (vscode) {
                    vscode.postMessage({
                        command: 'openFile',
                        nodeId: nodeId
                    });
                }
            }
        });
        
        // Analysis level functions
        function changeAnalysisLevel(newLevel) {
            if (vscode) {
                vscode.postMessage({
                    command: 'changeAnalysisLevel',
                    level: newLevel
                });
            }
        }
        
        
        // Generate dynamic legend for namespace colors
        function updateLegend() {
            if (vizConfig.namespaceColoring) {
                const legendItems = document.getElementById('legend-items');
                const namespaces = new Set();
                
                // Collect all namespaces
                rawNodesData.forEach(node => {
                    if (node.namespace && !node.isCircular) {
                        namespaces.add(node.namespace);
                    }
                });
                
                // Clear existing namespace legend items
                const existingNamespaces = legendItems.querySelectorAll('.namespace-legend');
                existingNamespaces.forEach(item => item.remove());
                
                // Add namespace legend items
                const namespacesArray = Array.from(namespaces).sort();
                namespacesArray.forEach(namespace => {
                    const color = getNamespaceColor(namespace, vizConfig.colorScheme);
                    const legendItem = document.createElement('div');
                    legendItem.className = 'legend-item namespace-legend';
                    legendItem.innerHTML = \`
                        <div class="legend-color" style="background-color: \${color.background}; border: 1px solid \${color.border};"></div>
                        <span>\${namespace}</span>
                    \`;
                    legendItems.appendChild(legendItem);
                });
            }
        }
        
        // Initialize with hierarchical layout
        window.addEventListener('load', function() {
            network.stabilize();
            updateLegend();
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
        
        lines.push(`<br>`);
        
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
            case 'edgeDoubleClicked':
                await this.handleEdgeDoubleClick(message.edgeData);
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
     * Handle edge double-click events - display edge (arrow) details
     */
    private async handleEdgeDoubleClick(edgeData: any): Promise<void> {
        try {
            // Handle reasons - they come as an array with single string that may contain \n separators
            if (edgeData.reasons && edgeData.reasons.length > 0) {
                let reasonIndex = 1;
                edgeData.reasons.forEach(async (reasonBlock: string) => {
                    // Split by newline in case multiple reasons are in one string
                    const individualReasons = reasonBlock.split('\\n').filter((r: string) => r.trim().length > 0);
                    const match = individualReasons[0].match(/^(.+):(\d+)\s*\(/);
                    if (match) {
                        const filePath = match[1];  // "Assets/Scripts/Combat/FindTargetSystem.cs"
                        const lineNumber = parseInt(match[2], 10) - 1;  // 7 (VS Code uses 0-based indexing)
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                        if (workspaceFolder) {
                            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                            // Open the file at the specific line
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            const editor = await vscode.window.showTextDocument(doc);
                            const position = new vscode.Position(lineNumber, 0);
                            editor.selection = new vscode.Selection(position, position);
                            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                        }
                    }

                });
            } else {
                this.outputChannel.appendLine('  No specific reasons available');
            }
            
            // this.outputChannel.show(true); // Show output channel without taking focus
            
        } catch (error) {
            this.outputChannel.appendLine(`Error handling edge double-click: ${error}`);
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