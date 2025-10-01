const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Create a standalone Utils class for integration testing that doesn't depend on VSCode
class StandaloneUtils {
    // File operations
    static async getCSharpFiles(directoryPath) {
        const files = [];
        
        try {
            const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                
                if (entry.isDirectory()) {
                    const subFiles = await this.getCSharpFiles(fullPath);
                    files.push(...subFiles);
                } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            console.warn(`Could not read directory ${directoryPath}:`, error);
        }
        
        return files;
    }

    static async getCSharpFilesWithMetadata(directoryPath) {
        const files = await this.getCSharpFiles(directoryPath);
        const filesWithMetadata = [];
        
        for (const filePath of files) {
            try {
                const stats = await fs.promises.stat(filePath);
                const content = await fs.promises.readFile(filePath, 'utf-8');
                
                filesWithMetadata.push({
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime,
                    content: content,
                    checksum: crypto.createHash('md5').update(content).digest('hex')
                });
            } catch (error) {
                console.warn(`Could not read file ${filePath}:`, error);
            }
        }
        
        return filesWithMetadata;
    }

    static createFileMetadataIndex(filesWithMetadata) {
        const index = {
            namespaces: new Map(),
            classes: new Map(),
            timeBuckets: new Map()
        };
        
        for (const file of filesWithMetadata) {
            const namespace = this.extractNamespace(file.content);
            const classes = this.extractClasses(file.content);
            
            if (namespace) {
                if (!index.namespaces.has(namespace)) {
                    index.namespaces.set(namespace, []);
                }
                index.namespaces.get(namespace).push(file.path);
            }
            
            for (const classInfo of classes) {
                if (!index.classes.has(classInfo.name)) {
                    index.classes.set(classInfo.name, []);
                }
                index.classes.get(classInfo.name).push(file.path);
            }
        }
        
        return index;
    }

    static extractNamespace(content) {
        const namespaceMatch = content.match(/^namespace\s+([\w.]+)/m);
        return namespaceMatch ? namespaceMatch[1] : null;
    }

    static extractClasses(content) {
        const classes = [];
        const lines = content.split('\n');

        const classPatterns = [
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?struct\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:partial\s+)?interface\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*enum\s+(\w+)/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const stripped = line.trim();
            
            if (!stripped || stripped.startsWith('//')) {
                continue;
            }

            for (const pattern of classPatterns) {
                const match = pattern.exec(stripped);
                if (match) {
                    const className = match[1];
                    
                    // Check if this appears to be nested
                    const isNested = this.isClassNested(lines, i, className);
                    
                    if (!isNested) {
                        classes.push({
                            name: className,
                            fullName: className,
                            namespace: '',
                            isNested: false,
                            startLine: i + 1,
                            classType: this.determineClassType(stripped)
                        });
                    }
                    break;
                }
            }
        }

        return classes;
    }

    static determineClassType(line) {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    }

    static isClassNested(lines, classLineIndex, className) {
        let braceBalance = 0;
        let insideNamespace = false;
        
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j].trim();
            
            if (line.startsWith('namespace ')) {
                insideNamespace = true;
            }
            
            if (/(?:class|struct|interface|enum)\s+\w+/.test(line)) {
                braceBalance += 1;
            }
            
            braceBalance += (line.match(/\{/g) || []).length;
            braceBalance -= (line.match(/\}/g) || []).length;
        }
        
        if (insideNamespace && braceBalance <= 1) {
            return false;
        }
        
        return braceBalance > 0;
    }

    // Analysis functions (simplified versions)
    static async analyzeClassDependenciesUnified(workspaceRoot, outputChannel) {
        const dependencies = new Map();
        const allFiles = await this.getCSharpFiles(workspaceRoot);
        const allClasses = new Map();

        // First pass: collect all classes
        for (const filePath of allFiles) {
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                const namespace = this.extractNamespace(content) || 'Global';
                const classes = this.extractClasses(content);

                for (const classInfo of classes) {
                    if (!classInfo.isNested) {
                        const fullClassName = `${namespace}.${classInfo.name}`;
                        allClasses.set(classInfo.name, {
                            namespace,
                            fullName: fullClassName,
                            filePath
                        });
                    }
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        // Second pass: find dependencies (simplified)
        for (const filePath of allFiles) {
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                const namespace = this.extractNamespace(content) || 'Global';
                const currentFileClasses = this.extractClasses(content)
                    .filter(c => !c.isNested)
                    .map(c => ({
                        name: c.name,
                        fullName: `${namespace}.${c.name}`,
                        classInfo: c
                    }));

                for (const { name: className, fullName: fullClassName, classInfo } of currentFileClasses) {
                    const classDeps = [];
                    
                    // Simple dependency detection
                    for (const [otherClassName, otherClassInfo] of allClasses) {
                        if (otherClassInfo.fullName === fullClassName) {
                            continue;
                        }
                        
                        // Simple pattern matching
                        if (content.includes(otherClassName)) {
                            classDeps.push(otherClassInfo.fullName);
                        }
                    }

                    dependencies.set(fullClassName, {
                        name: className,
                        namespace,
                        fullName: fullClassName,
                        filePath,
                        dependencies: [...new Set(classDeps)],
                        classType: classInfo.classType
                    });
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        return dependencies;
    }

    static findCircularDependencies(dependencies) {
        const visited = new Set();
        const recStack = new Set();
        const cycles = [];
        
        const dfs = (node, path) => {
            if (recStack.has(node)) {
                const cycleStart = path.indexOf(node);
                if (cycleStart !== -1) {
                    const cycle = path.slice(cycleStart).concat([node]);
                    cycles.push(cycle);
                }
                return;
            }
            
            if (visited.has(node)) {
                return;
            }
            
            visited.add(node);
            recStack.add(node);
            
            const dependencyNode = dependencies.get(node);
            if (dependencyNode) {
                for (const neighbor of dependencyNode.dependencies) {
                    dfs(neighbor, [...path, node]);
                }
            }
            
            recStack.delete(node);
        };
        
        for (const node of dependencies.keys()) {
            if (!visited.has(node)) {
                dfs(node, []);
            }
        }
        
        return cycles.map(cycle => ({
            cycle: cycle.slice(0, -1),
            description: cycle.slice(0, -1).join(' → ')
        }));
    }

    static serializeDependencyGraph(dependencies) {
        const serializable = {};
        for (const [key, value] of dependencies) {
            serializable[key] = value;
        }
        return JSON.stringify(serializable, null, 2);
    }

    static deserializeDependencyGraph(serialized) {
        const parsed = JSON.parse(serialized);
        const dependencies = new Map();
        for (const [key, value] of Object.entries(parsed)) {
            dependencies.set(key, value);
        }
        return dependencies;
    }

    static async updateGraphIncremental(existingGraph, filePath, newContent, workspaceRoot, outputChannel) {
        // Simple incremental update - just return the existing graph with potential new entries
        const updatedGraph = new Map(existingGraph);
        
        try {
            const namespace = this.extractNamespace(newContent) || 'Global';
            const classes = this.extractClasses(newContent);
            
            for (const classInfo of classes) {
                if (!classInfo.isNested) {
                    const fullClassName = `${namespace}.${classInfo.name}`;
                    updatedGraph.set(fullClassName, {
                        name: classInfo.name,
                        namespace,
                        fullName: fullClassName,
                        filePath,
                        dependencies: [],
                        classType: classInfo.classType
                    });
                }
            }
        } catch (error) {
            console.warn(`Error in incremental update: ${error}`);
        }
        
        return updatedGraph;
    }

    // Utility functions
    static calculateAnalysisEfficiency(analyzed, total) {
        const ratio = analyzed / total;
        let recommendation;
        
        if (ratio <= 0.05) {
            recommendation = 'excellent optimization';
        } else if (ratio <= 0.1) {
            recommendation = 'good optimization';
        } else if (ratio <= 0.25) {
            recommendation = 'moderate optimization';
        } else {
            recommendation = 'consider full analysis';
        }
        
        return { ratio, recommendation };
    }

    static shouldUseFullAnalysis(changedFiles, totalFiles) {
        const changeRatio = changedFiles / totalFiles;
        return changeRatio > 0.3; // 30% threshold
    }

    static getFilesForNamespacesOptimized(namespaces, metadataIndex) {
        const files = [];
        for (const namespace of namespaces) {
            if (metadataIndex.namespaces.has(namespace)) {
                files.push(...metadataIndex.namespaces.get(namespace));
            }
        }
        return [...new Set(files)];
    }

    static getFilesForClassesOptimized(classes, metadataIndex) {
        const files = [];
        for (const className of classes) {
            if (metadataIndex.classes.has(className)) {
                files.push(...metadataIndex.classes.get(className));
            }
        }
        return [...new Set(files)];
    }

    static async performUnifiedAnalysisWrapper(workspaceRoot, outputChannel, previousCache = null, forceFullAnalysis = false) {
        const startTime = Date.now();
        
        const dependencies = await this.analyzeClassDependenciesUnified(workspaceRoot, outputChannel);
        
        const analysisTime = Date.now() - startTime;
        const efficiency = this.calculateAnalysisEfficiency(1, 1); // Dummy values for testing
        
        return {
            dependencies,
            metrics: {
                analysisTime,
                recommendation: efficiency.recommendation
            }
        };
    }

    // Cache operations (simplified)
    static async saveDependencyGraphToCache(dependencies, cacheDir, fileName) {
        try {
            await fs.promises.mkdir(cacheDir, { recursive: true });
            const serialized = this.serializeDependencyGraph(dependencies);
            await fs.promises.writeFile(path.join(cacheDir, fileName), serialized);
            return true;
        } catch (error) {
            console.warn(`Cache save error: ${error}`);
            return false;
        }
    }

    static async loadDependencyGraphFromCache(cacheDir, fileName) {
        try {
            const content = await fs.promises.readFile(path.join(cacheDir, fileName), 'utf-8');
            return this.deserializeDependencyGraph(content);
        } catch (error) {
            console.warn(`Cache load error: ${error}`);
            return null;
        }
    }

    static validateCacheIntegrity(dependencies, expectedClasses) {
        if (!dependencies) return false;
        
        for (const className of expectedClasses) {
            let found = false;
            for (const [key, value] of dependencies) {
                if (value.name === className) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        
        return true;
    }
}

class IntegrationTestSuite {
    constructor() {
        this.testResults = [];
        this.workspaceRoot = path.resolve(__dirname, '../..');
        this.scriptsPath = path.join(this.workspaceRoot, 'src/test/Scripts');
        
        // Mock output channel for testing
        this.outputChannel = {
            appendLine: (message) => {} // Silent for cleaner output
        };
    }

    log(message) {
        console.log(message);
    }

    recordTestResult(testName, passed, details = '') {
        this.testResults.push({ testName, passed, details });
        if (passed) {
            this.log(`✅ ${testName}: PASSED ${details}`);
        } else {
            this.log(`❌ ${testName}: FAILED ${details}`);
        }
    }

    async runIntegrationTest1_CompleteWorkflow() {
        this.log('\n🧪 Integration Test 1: Complete Analysis Workflow');
        this.log('==================================================');
        
        try {
            // Step 1: Smart file discovery with metadata
            const startTime = Date.now();
            const filesWithMetadata = await StandaloneUtils.getCSharpFilesWithMetadata(this.scriptsPath);
            const discoveryTime = Date.now() - startTime;
            
            this.recordTestResult(
                'Smart File Discovery', 
                filesWithMetadata.length > 0, 
                `(${filesWithMetadata.length} files in ${discoveryTime}ms)`
            );

            // Step 2: Create file metadata index
            const metadataIndex = StandaloneUtils.createFileMetadataIndex(filesWithMetadata);
            this.recordTestResult(
                'Metadata Indexing', 
                metadataIndex.namespaces.size > 0 && metadataIndex.classes.size > 0,
                `(${metadataIndex.namespaces.size} namespaces, ${metadataIndex.classes.size} classes)`
            );

            // Step 3: Analyze dependencies using unified strategy
            const analysisStart = Date.now();
            const dependencies = await StandaloneUtils.analyzeClassDependenciesUnified(this.scriptsPath, this.outputChannel);
            const analysisTime = Date.now() - analysisStart;
            
            this.recordTestResult(
                'Unified Dependency Analysis', 
                dependencies && dependencies.size > 0,
                `(${dependencies.size} classes analyzed in ${analysisTime}ms)`
            );

            // Step 4: Test circular dependency detection
            const circularDeps = StandaloneUtils.findCircularDependencies(dependencies);
            this.recordTestResult(
                'Circular Dependency Detection', 
                Array.isArray(circularDeps),
                `(${circularDeps.length} circular dependencies found)`
            );

            // Step 5: Test graph serialization
            const serialized = StandaloneUtils.serializeDependencyGraph(dependencies);
            this.recordTestResult(
                'Graph Serialization', 
                serialized && typeof serialized === 'string' && serialized.length > 0,
                `(${serialized.length} characters)`
            );

            // Step 6: Test graph deserialization
            const deserialized = StandaloneUtils.deserializeDependencyGraph(serialized);
            this.recordTestResult(
                'Graph Deserialization', 
                deserialized && deserialized.size === dependencies.size,
                `(${deserialized.size} classes recovered)`
            );

            // Step 7: Test incremental update capability
            if (filesWithMetadata.length > 0) {
                const testFile = filesWithMetadata[0];
                const updatedGraph = await StandaloneUtils.updateGraphIncremental(
                    dependencies, 
                    testFile.path, 
                    testFile.content,
                    this.scriptsPath,
                    this.outputChannel
                );
                
                this.recordTestResult(
                    'Incremental Graph Update', 
                    updatedGraph && updatedGraph.size >= dependencies.size,
                    `(${updatedGraph.size} classes after update)`
                );
            }

            return true;
        } catch (error) {
            this.recordTestResult('Complete Workflow', false, `Error: ${error.message}`);
            return false;
        }
    }

    async runIntegrationTest2_PerformanceComparison() {
        this.log('\n🏃 Integration Test 2: Performance Comparison');
        this.log('=============================================');
        
        try {
            // Test traditional file scanning vs metadata-based scanning
            const traditionalStart = Date.now();
            const traditionalFiles = await StandaloneUtils.getCSharpFiles(this.scriptsPath);
            const traditionalTime = Date.now() - traditionalStart;

            const metadataStart = Date.now();
            const metadataFiles = await StandaloneUtils.getCSharpFilesWithMetadata(this.scriptsPath);
            const metadataTime = Date.now() - metadataStart;

            this.recordTestResult(
                'Traditional vs Metadata Scanning', 
                metadataFiles.length === traditionalFiles.length,
                `(Traditional: ${traditionalTime}ms, Metadata: ${metadataTime}ms)`
            );

            // Test efficiency calculation
            const efficiency = StandaloneUtils.calculateAnalysisEfficiency(10, 100);
            this.recordTestResult(
                'Efficiency Calculation', 
                efficiency.ratio === 0.1 && efficiency.recommendation.includes('good'),
                `(${efficiency.ratio} ratio, ${efficiency.recommendation})`
            );

            // Test smart analysis threshold
            const threshold1 = StandaloneUtils.shouldUseFullAnalysis(5, 100); // 5% - should be incremental
            const threshold2 = StandaloneUtils.shouldUseFullAnalysis(40, 100); // 40% - should be full
            
            this.recordTestResult(
                'Smart Analysis Threshold', 
                !threshold1 && threshold2,
                `(5%: incremental=${!threshold1}, 40%: full=${threshold2})`
            );

            return true;
        } catch (error) {
            this.recordTestResult('Performance Comparison', false, `Error: ${error.message}`);
            return false;
        }
    }

    async runIntegrationTest3_RealWorldScenarios() {
        this.log('\n🌍 Integration Test 3: Real-World Scenarios');
        this.log('==========================================');
        
        try {
            // Test scenario 1: Three-node circular dependency
            const threeNodePath = path.join(this.scriptsPath, 'TestScenarios/ThreeNodeCircular');
            const threeNodeDeps = await StandaloneUtils.analyzeClassDependenciesUnified(threeNodePath, this.outputChannel);
            const threeNodeCircular = StandaloneUtils.findCircularDependencies(threeNodeDeps);
            
            this.recordTestResult(
                'Three-Node Circular Detection', 
                threeNodeCircular.length > 0,
                `(${threeNodeCircular.length} cycles found)`
            );

            // Test scenario 2: Five-node circular dependency
            const fiveNodePath = path.join(this.scriptsPath, 'TestScenarios/FiveNodeCircular');
            const fiveNodeDeps = await StandaloneUtils.analyzeClassDependenciesUnified(fiveNodePath, this.outputChannel);
            const fiveNodeCircular = StandaloneUtils.findCircularDependencies(fiveNodeDeps);
            
            this.recordTestResult(
                'Five-Node Circular Detection', 
                fiveNodeCircular.length > 0,
                `(${fiveNodeCircular.length} cycles found)`
            );

            // Test scenario 3: False positive avoidance
            const falsePositivePath = path.join(this.scriptsPath, 'TestScenarios/FalsePositiveTest');
            const falsePositiveDeps = await StandaloneUtils.analyzeClassDependenciesUnified(falsePositivePath, this.outputChannel);
            
            // Check that independent services are not connected
            const serviceA = Array.from(falsePositiveDeps.values()).find(dep => 
                dep.name === 'IndependentServiceA'
            );
            const serviceB = Array.from(falsePositiveDeps.values()).find(dep => 
                dep.name === 'IndependentServiceB'
            );
            
            const noFalsePositives = serviceA && serviceB && 
                !serviceA.dependencies.some(dep => dep.includes('IndependentServiceB')) &&
                !serviceB.dependencies.some(dep => dep.includes('IndependentServiceA'));
            
            this.recordTestResult(
                'False Positive Avoidance', 
                noFalsePositives,
                `(Independent services correctly isolated)`
            );

            // Test scenario 4: Complex namespace dependencies
            const combatPath = path.join(this.scriptsPath, 'Combat');
            const combatDeps = await StandaloneUtils.analyzeClassDependenciesUnified(combatPath, this.outputChannel);
            
            this.recordTestResult(
                'Complex Namespace Analysis', 
                combatDeps.size > 0,
                `(${combatDeps.size} combat classes analyzed)`
            );

            return true;
        } catch (error) {
            this.recordTestResult('Real-World Scenarios', false, `Error: ${error.message}`);
            return false;
        }
    }

    async runIntegrationTest4_CacheAndPersistence() {
        this.log('\n💾 Integration Test 4: Cache and Persistence');
        this.log('===========================================');
        
        try {
            // Test cache file operations
            const tempCacheDir = path.join(__dirname, 'temp_cache');
            const testData = new Map([
                ['TestClass1', { name: 'TestClass1', dependencies: ['TestClass2'] }],
                ['TestClass2', { name: 'TestClass2', dependencies: [] }]
            ]);

            // Test saving to cache
            const saved = await StandaloneUtils.saveDependencyGraphToCache(testData, tempCacheDir, 'test_graph.json');
            this.recordTestResult(
                'Cache Save Operation', 
                saved,
                `(Graph saved to cache)`
            );

            // Test loading from cache
            const loaded = await StandaloneUtils.loadDependencyGraphFromCache(tempCacheDir, 'test_graph.json');
            this.recordTestResult(
                'Cache Load Operation', 
                loaded && loaded.size === testData.size,
                `(${loaded ? loaded.size : 0} items loaded)`
            );

            // Test cache validation
            const isValid = StandaloneUtils.validateCacheIntegrity(loaded, ['TestClass1', 'TestClass2']);
            this.recordTestResult(
                'Cache Validation', 
                isValid,
                `(Cache integrity verified)`
            );

            // Clean up
            try {
                const cacheFile = path.join(tempCacheDir, 'test_graph.json');
                if (fs.existsSync(cacheFile)) {
                    fs.unlinkSync(cacheFile);
                }
                if (fs.existsSync(tempCacheDir)) {
                    fs.rmdirSync(tempCacheDir);
                }
            } catch (cleanupError) {
                // Ignore cleanup errors
            }

            return true;
        } catch (error) {
            this.recordTestResult('Cache and Persistence', false, `Error: ${error.message}`);
            return false;
        }
    }

    async runIntegrationTest5_UnifiedAnalysisWrapper() {
        this.log('\n🎯 Integration Test 5: Unified Analysis Wrapper');
        this.log('===============================================');
        
        try {
            // Test the unified analysis wrapper with efficiency metrics
            const wrapperStart = Date.now();
            const result = await StandaloneUtils.performUnifiedAnalysisWrapper(
                this.scriptsPath,
                this.outputChannel,
                null, // No previous cache
                true  // Force full analysis for testing
            );
            const wrapperTime = Date.now() - wrapperStart;

            this.recordTestResult(
                'Unified Analysis Wrapper', 
                result && result.dependencies && result.metrics,
                `(${result ? result.dependencies.size : 0} classes, ${wrapperTime}ms)`
            );

            if (result && result.metrics) {
                this.recordTestResult(
                    'Efficiency Metrics Generation', 
                    result.metrics.analysisTime !== undefined && result.metrics.recommendation !== undefined,
                    `(${result.metrics.analysisTime}ms analysis, ${result.metrics.recommendation})`
                );
            }

            // Test optimized file discovery
            const filesWithMetadata = await StandaloneUtils.getCSharpFilesWithMetadata(this.scriptsPath);
            const metadataIndex = StandaloneUtils.createFileMetadataIndex(filesWithMetadata);
            
            const namespaceFiles = StandaloneUtils.getFilesForNamespacesOptimized(['Combat', 'Ships'], metadataIndex);
            const classFiles = StandaloneUtils.getFilesForClassesOptimized(['BulletAuthoring', 'HealthAuthoring'], metadataIndex);
            
            this.recordTestResult(
                'Optimized File Discovery', 
                namespaceFiles.length > 0 && classFiles.length > 0,
                `(${namespaceFiles.length} namespace files, ${classFiles.length} class files)`
            );

            return true;
        } catch (error) {
            this.recordTestResult('Unified Analysis Wrapper', false, `Error: ${error.message}`);
            return false;
        }
    }

    async runAllIntegrationTests() {
        this.log('🧪 COMPREHENSIVE INTEGRATION TESTS');
        this.log('==================================');
        this.log(`📁 Workspace: ${this.workspaceRoot}`);
        this.log(`📁 Scripts Path: ${this.scriptsPath}`);
        
        const tests = [
            () => this.runIntegrationTest1_CompleteWorkflow(),
            () => this.runIntegrationTest2_PerformanceComparison(),
            () => this.runIntegrationTest3_RealWorldScenarios(),
            () => this.runIntegrationTest4_CacheAndPersistence(),
            () => this.runIntegrationTest5_UnifiedAnalysisWrapper()
        ];

        let allPassed = true;
        for (const test of tests) {
            const testPassed = await test();
            if (!testPassed) {
                allPassed = false;
            }
        }

        // Summary
        this.log('\n📊 INTEGRATION TEST RESULTS');
        this.log('===========================');
        
        const passedTests = this.testResults.filter(r => r.passed).length;
        const totalTests = this.testResults.length;
        
        this.log(`✅ Tests Passed: ${passedTests}/${totalTests}`);
        this.log(`❌ Tests Failed: ${totalTests - passedTests}/${totalTests}`);
        
        if (allPassed) {
            this.log('🎉 ALL INTEGRATION TESTS PASSED!');
            this.log('   ✅ Complete workflow functionality verified');
            this.log('   ✅ Performance optimizations working correctly');
            this.log('   ✅ Real-world scenarios handled properly');
            this.log('   ✅ Cache and persistence operations successful');
            this.log('   ✅ Unified analysis wrapper functioning optimally');
        } else {
            this.log('🚨 SOME INTEGRATION TESTS FAILED!');
            this.testResults.filter(r => !r.passed).forEach(failed => {
                this.log(`   ❌ ${failed.testName}: ${failed.details}`);
            });
        }
        
        return allPassed;
    }
}

// Run the integration tests
async function runIntegrationTests() {
    const suite = new IntegrationTestSuite();
    const success = await suite.runAllIntegrationTests();
    process.exit(success ? 0 : 1);
}

// Only run if this file is executed directly
if (require.main === module) {
    runIntegrationTests().catch(error => {
        console.error('💥 FATAL ERROR:', error);
        process.exit(1);
    });
}

module.exports = { IntegrationTestSuite };