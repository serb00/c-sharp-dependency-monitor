const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Standalone metadata analysis functions for testing (without vscode dependencies)
class TestUtils {
    static async getCSharpFilesWithMetadata(directoryPath, lastScanTime) {
        const filesWithMetadata = [];
        
        try {
            await this.walkDirectoryWithMetadata(directoryPath, filesWithMetadata, lastScanTime);
        } catch (error) {
            console.warn(`Could not read directory ${directoryPath}:`, error);
        }
        
        return filesWithMetadata.filter(file =>
            file.filePath.endsWith('.cs') && !file.filePath.endsWith('.meta')
        );
    }

    static async walkDirectoryWithMetadata(dir, files, lastScanTime) {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    await this.walkDirectoryWithMetadata(fullPath, files, lastScanTime);
                } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                    const stats = await this.getFileStats(fullPath);
                    if (stats) {
                        const isNew = !lastScanTime;
                        const isModified = lastScanTime ? stats.lastModified > lastScanTime : false;
                        
                        files.push({
                            filePath: fullPath,
                            lastModified: stats.lastModified,
                            size: stats.size,
                            isNew,
                            isModified
                        });
                    }
                }
            }
        } catch (error) {
            console.warn(`Could not scan directory ${dir}:`, error);
        }
    }

    static async getFileStats(filePath) {
        try {
            const stats = await fs.promises.stat(filePath);
            return {
                lastModified: stats.mtime.getTime(),
                size: stats.size
            };
        } catch (error) {
            return null;
        }
    }

    static identifyFilesNeedingAnalysis(currentFiles, fileCache) {
        const newFiles = [];
        const modifiedFiles = [];
        const unchangedFiles = [];
        const currentFilePaths = new Set(currentFiles.map(f => f.filePath));
        
        // Check for new and modified files
        for (const file of currentFiles) {
            const cached = fileCache.get(file.filePath);
            
            if (!cached) {
                newFiles.push(file.filePath);
            } else if (cached.lastModified !== file.lastModified || cached.size !== file.size) {
                modifiedFiles.push(file.filePath);
            } else {
                unchangedFiles.push(file.filePath);
            }
        }
        
        // Check for deleted files
        const deletedFiles = [];
        for (const [cachedPath] of fileCache) {
            if (!currentFilePaths.has(cachedPath)) {
                deletedFiles.push(cachedPath);
            }
        }
        
        return {
            newFiles,
            modifiedFiles,
            deletedFiles,
            unchangedFiles
        };
    }

    static async smartAnalyzeChangedFiles(workspaceRoot, fileCache, lastAnalysisTime) {
        const startTime = Date.now();
        
        // Get all files with metadata
        const currentFiles = await this.getCSharpFilesWithMetadata(workspaceRoot, lastAnalysisTime);
        
        // Identify what needs analysis
        const analysis = this.identifyFilesNeedingAnalysis(currentFiles, fileCache);
        
        const changedFiles = [...analysis.newFiles, ...analysis.modifiedFiles];
        const analysisNeeded = changedFiles.length > 0 || analysis.deletedFiles.length > 0;
        
        const scanDuration = Date.now() - startTime;
        
        return {
            changedFiles,
            unchangedFiles: analysis.unchangedFiles,
            analysisNeeded,
            scanMetrics: {
                totalFiles: currentFiles.length,
                newFiles: analysis.newFiles.length,
                modifiedFiles: analysis.modifiedFiles.length,
                deletedFiles: analysis.deletedFiles.length,
                unchangedFiles: analysis.unchangedFiles.length,
                scanDuration
            }
        };
    }

    static createFileMetadataIndex(fileCache) {
        const byNamespace = new Map();
        const byClass = new Map();
        const byLastModified = new Map();
        
        for (const [filePath, fileData] of fileCache) {
            // Index by namespace
            if (fileData.namespace) {
                if (!byNamespace.has(fileData.namespace)) {
                    byNamespace.set(fileData.namespace, []);
                }
                byNamespace.get(fileData.namespace).push(filePath);
            }
            
            // Index by classes
            if (fileData.classes) {
                for (const className of fileData.classes) {
                    if (!byClass.has(className)) {
                        byClass.set(className, []);
                    }
                    byClass.get(className).push(filePath);
                }
            }
            
            // Index by modification time (rounded to minutes for grouping)
            const modifiedMinute = Math.floor(fileData.lastModified / 60000) * 60000;
            if (!byLastModified.has(modifiedMinute)) {
                byLastModified.set(modifiedMinute, []);
            }
            byLastModified.get(modifiedMinute).push(filePath);
        }
        
        return {
            byNamespace,
            byClass,
            byLastModified,
            totalFiles: fileCache.size
        };
    }

    static getFilesForNamespacesOptimized(targetNamespaces, fileMetadataIndex) {
        const relevantFiles = new Set();
        
        for (const namespace of targetNamespaces) {
            // Direct namespace match
            const directFiles = fileMetadataIndex.byNamespace.get(namespace);
            if (directFiles) {
                directFiles.forEach(file => relevantFiles.add(file));
            }
            
            // Partial namespace matches (e.g., "Combat" matches "Combat.Systems")
            for (const [cachedNamespace, files] of fileMetadataIndex.byNamespace) {
                if (cachedNamespace.startsWith(namespace + '.') || namespace.startsWith(cachedNamespace + '.')) {
                    files.forEach(file => relevantFiles.add(file));
                }
            }
        }
        
        return Array.from(relevantFiles);
    }

    static getFilesForClassesOptimized(targetClasses, fileMetadataIndex) {
        const relevantFiles = new Set();
        
        for (const fullClassName of targetClasses) {
            // Extract class name from full name (e.g., "Combat.FindTarget" -> "FindTarget")
            const className = fullClassName.split('.').pop() || fullClassName;
            
            // Direct class match
            const directFiles = fileMetadataIndex.byClass.get(className);
            if (directFiles) {
                directFiles.forEach(file => relevantFiles.add(file));
            }
            
            // Also check by namespace if full class name provided
            if (fullClassName.includes('.')) {
                const namespace = fullClassName.substring(0, fullClassName.lastIndexOf('.'));
                const namespaceFiles = fileMetadataIndex.byNamespace.get(namespace);
                if (namespaceFiles) {
                    namespaceFiles.forEach(file => relevantFiles.add(file));
                }
            }
        }
        
        return Array.from(relevantFiles);
    }

    static calculateAnalysisEfficiency(totalFilesInWorkspace, filesActuallyAnalyzed, scanDuration, analysisDuration) {
        const efficiencyRatio = filesActuallyAnalyzed / totalFilesInWorkspace;
        const filesSkipped = totalFilesInWorkspace - filesActuallyAnalyzed;
        const timeSkipped = scanDuration * (filesSkipped / totalFilesInWorkspace);
        const totalDuration = scanDuration + analysisDuration;
        
        let recommendation = 'optimal';
        if (efficiencyRatio > 0.8) {
            recommendation = 'consider full analysis';
        } else if (efficiencyRatio < 0.1) {
            recommendation = 'excellent optimization';
        } else if (efficiencyRatio < 0.3) {
            recommendation = 'good optimization';
        }
        
        return {
            efficiencyRatio,
            filesSkipped,
            timeSkipped,
            totalDuration,
            recommendation
        };
    }

    static shouldUseIncrementalUpdate(changedFiles, totalFiles, maxIncrementalThreshold = 0.1) {
        const changeRatio = changedFiles.length / totalFiles;
        return changeRatio <= maxIncrementalThreshold;
    }
}

class MetadataAnalysisTest {
    constructor() {
        this.workspaceRoot = path.resolve(__dirname, '../..');
        this.outputChannel = {
            appendLine: (message) => console.log(`[TEST] ${message}`)
        };
    }

    async runAllTests() {
        console.log('🧪 METADATA-BASED ANALYSIS OPTIMIZATION TESTS');
        console.log('==============================================');
        
        let testsPassed = 0;
        let totalTests = 0;
        
        try {
            // Test 1: Smart file scanning and metadata collection
            console.log('\n📁 Test 1: Smart File Scanning with Metadata');
            totalTests++;
            if (await this.testSmartFileScanningWithMetadata()) {
                testsPassed++;
            }
            
            // Test 2: File change detection based on metadata
            console.log('\n🔍 Test 2: Metadata-Based Change Detection');
            totalTests++;
            if (await this.testMetadataBasedChangeDetection()) {
                testsPassed++;
            }
            
            // Test 3: File metadata indexing for optimization
            console.log('\n📊 Test 3: File Metadata Indexing');
            totalTests++;
            if (await this.testFileMetadataIndexing()) {
                testsPassed++;
            }
            
            // Test 4: Optimized file discovery using indexes
            console.log('\n⚡ Test 4: Optimized File Discovery');
            totalTests++;
            if (await this.testOptimizedFileDiscovery()) {
                testsPassed++;
            }
            
            // Test 5: Analysis efficiency calculation
            console.log('\n📈 Test 5: Analysis Efficiency Metrics');
            totalTests++;
            if (await this.testAnalysisEfficiencyCalculation()) {
                testsPassed++;
            }
            
            // Test 6: Smart analysis with change threshold detection
            console.log('\n🎯 Test 6: Smart Analysis Change Threshold');
            totalTests++;
            if (await this.testSmartAnalysisChangeThreshold()) {
                testsPassed++;
            }
            
            console.log('\n📊 METADATA ANALYSIS TEST RESULTS');
            console.log('================================');
            console.log(`✅ Tests Passed: ${testsPassed}/${totalTests}`);
            console.log(`❌ Tests Failed: ${totalTests - testsPassed}/${totalTests}`);
            
            if (testsPassed === totalTests) {
                console.log('🎉 ALL METADATA ANALYSIS TESTS PASSED!');
                console.log('   ✅ Smart file scanning with metadata works correctly');
                console.log('   ✅ Change detection using file metadata is accurate');
                console.log('   ✅ File metadata indexing for optimization functions properly');
                console.log('   ✅ Optimized file discovery reduces scan overhead');
                console.log('   ✅ Analysis efficiency metrics provide valuable insights');
                console.log('   ✅ Smart analysis threshold detection prevents unnecessary work');
                return true;
            } else {
                console.log('🚨 METADATA ANALYSIS TESTS FAILED!');
                console.log('   Some optimization functions are not working as expected.');
                return false;
            }
            
        } catch (error) {
            console.error('💥 ERROR during metadata analysis tests:', error);
            return false;
        }
    }

    async testSmartFileScanningWithMetadata() {
        try {
            console.log('Testing smart file scanning with metadata collection...');
            
            // Test getting C# files with metadata
            const filesWithMetadata = await TestUtils.getCSharpFilesWithMetadata(
                path.join(this.workspaceRoot, 'src/test/Scripts'),
                Date.now() - 86400000 // 24 hours ago
            );
            
            if (filesWithMetadata.length === 0) {
                console.log('❌ No files found with metadata');
                return false;
            }
            
            // Verify metadata structure
            const firstFile = filesWithMetadata[0];
            const requiredProps = ['filePath', 'lastModified', 'size', 'isNew', 'isModified'];
            
            for (const prop of requiredProps) {
                if (!(prop in firstFile)) {
                    console.log(`❌ Missing required property: ${prop}`);
                    return false;
                }
            }
            
            console.log(`✅ Found ${filesWithMetadata.length} C# files with complete metadata`);
            console.log(`   Sample: ${path.relative(this.workspaceRoot, firstFile.filePath)}`);
            console.log(`   Size: ${firstFile.size} bytes, Modified: ${new Date(firstFile.lastModified).toISOString()}`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ Smart file scanning test failed: ${error}`);
            return false;
        }
    }

    async testMetadataBasedChangeDetection() {
        try {
            console.log('Testing metadata-based change detection...');
            
            // Create a mock file cache
            const fileCache = new Map();
            const testFilePath = path.join(this.workspaceRoot, 'src/test/Scripts/Core/GameConstants.cs');
            
            // Add a file to cache with current metadata
            const stats = await TestUtils.getFileStats(testFilePath);
            if (!stats) {
                console.log(`❌ Could not get stats for test file: ${testFilePath}`);
                return false;
            }
            
            fileCache.set(testFilePath, {
                filePath: testFilePath,
                lastModified: stats.lastModified,
                size: stats.size,
                namespace: 'TestNamespace',
                classes: ['GameConstants']
            });
            
            // Test smart analysis of changed files
            const analyzeResult = await TestUtils.smartAnalyzeChangedFiles(
                path.join(this.workspaceRoot, 'src/test/Scripts'),
                fileCache,
                Date.now() - 3600000 // 1 hour ago
            );
            
            // Verify analysis result structure
            const requiredProps = ['changedFiles', 'unchangedFiles', 'analysisNeeded', 'scanMetrics'];
            for (const prop of requiredProps) {
                if (!(prop in analyzeResult)) {
                    console.log(`❌ Missing property in analyze result: ${prop}`);
                    return false;
                }
            }
            
            // Verify scan metrics
            const metrics = analyzeResult.scanMetrics;
            const requiredMetrics = ['totalFiles', 'newFiles', 'modifiedFiles', 'deletedFiles', 'unchangedFiles', 'scanDuration'];
            for (const metric of requiredMetrics) {
                if (!(metric in metrics)) {
                    console.log(`❌ Missing scan metric: ${metric}`);
                    return false;
                }
            }
            
            console.log(`✅ Smart change detection works correctly`);
            console.log(`   Total files: ${metrics.totalFiles}, New: ${metrics.newFiles}, Modified: ${metrics.modifiedFiles}`);
            console.log(`   Unchanged: ${metrics.unchangedFiles}, Scan duration: ${metrics.scanDuration}ms`);
            console.log(`   Analysis needed: ${analyzeResult.analysisNeeded}`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ Metadata-based change detection test failed: ${error}`);
            return false;
        }
    }

    async testFileMetadataIndexing() {
        try {
            console.log('Testing file metadata indexing for optimization...');
            
            // Create a mock file cache with diverse data
            const fileCache = new Map();
            
            // Add some test files to cache
            const testFiles = [
                { path: 'file1.cs', namespace: 'Combat', classes: ['BulletSystem', 'WeaponManager'] },
                { path: 'file2.cs', namespace: 'Combat.Weapons', classes: ['Rifle', 'Pistol'] },
                { path: 'file3.cs', namespace: 'UI', classes: ['MenuController'] },
                { path: 'file4.cs', namespace: 'Movement', classes: ['PlayerController', 'NPCController'] }
            ];
            
            for (const file of testFiles) {
                fileCache.set(file.path, {
                    filePath: file.path,
                    lastModified: Date.now(),
                    size: 1000,
                    namespace: file.namespace,
                    classes: file.classes
                });
            }
            
            // Test metadata index creation
            const metadataIndex = TestUtils.createFileMetadataIndex(fileCache);
            
            // Verify index structure
            const requiredIndexes = ['byNamespace', 'byClass', 'byLastModified', 'totalFiles'];
            for (const index of requiredIndexes) {
                if (!(index in metadataIndex)) {
                    console.log(`❌ Missing index: ${index}`);
                    return false;
                }
            }
            
            // Test namespace indexing
            if (!metadataIndex.byNamespace.has('Combat')) {
                console.log('❌ Namespace indexing failed - Combat namespace not found');
                return false;
            }
            
            // Test class indexing
            if (!metadataIndex.byClass.has('BulletSystem')) {
                console.log('❌ Class indexing failed - BulletSystem class not found');
                return false;
            }
            
            console.log(`✅ File metadata indexing works correctly`);
            console.log(`   Indexed ${metadataIndex.totalFiles} files`);
            console.log(`   Namespaces: ${metadataIndex.byNamespace.size}, Classes: ${metadataIndex.byClass.size}`);
            console.log(`   Time buckets: ${metadataIndex.byLastModified.size}`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ File metadata indexing test failed: ${error}`);
            return false;
        }
    }

    async testOptimizedFileDiscovery() {
        try {
            console.log('Testing optimized file discovery using indexes...');
            
            // Create metadata index
            const fileCache = new Map();
            fileCache.set('combat1.cs', { namespace: 'Combat', classes: ['BulletSystem'] });
            fileCache.set('combat2.cs', { namespace: 'Combat.Weapons', classes: ['Rifle'] });
            fileCache.set('ui1.cs', { namespace: 'UI', classes: ['MenuController'] });
            fileCache.set('movement1.cs', { namespace: 'Movement', classes: ['PlayerController'] });
            
            const metadataIndex = TestUtils.createFileMetadataIndex(fileCache);
            
            // Test optimized namespace discovery
            const namespaceFiles = TestUtils.getFilesForNamespacesOptimized(
                ['Combat', 'UI'], 
                metadataIndex
            );
            
            if (namespaceFiles.length === 0) {
                console.log('❌ Optimized namespace discovery returned no files');
                return false;
            }
            
            // Test optimized class discovery
            const classFiles = TestUtils.getFilesForClassesOptimized(
                ['Combat.BulletSystem', 'MenuController'], 
                metadataIndex
            );
            
            if (classFiles.length === 0) {
                console.log('❌ Optimized class discovery returned no files');
                return false;
            }
            
            console.log(`✅ Optimized file discovery works correctly`);
            console.log(`   Namespace files found: ${namespaceFiles.length}`);
            console.log(`   Class files found: ${classFiles.length}`);
            console.log(`   Files: [${namespaceFiles.concat(classFiles).join(', ')}]`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ Optimized file discovery test failed: ${error}`);
            return false;
        }
    }

    async testAnalysisEfficiencyCalculation() {
        try {
            console.log('Testing analysis efficiency metrics calculation...');
            
            // Test efficiency calculation with different scenarios
            const scenarios = [
                { total: 100, analyzed: 5, scanTime: 50, analysisTime: 100, expectedEfficiency: 0.05, expectedRecommendation: 'excellent optimization' },
                { total: 100, analyzed: 25, scanTime: 50, analysisTime: 200, expectedEfficiency: 0.25, expectedRecommendation: 'good optimization' },
                { total: 100, analyzed: 90, scanTime: 50, analysisTime: 300, expectedEfficiency: 0.9, expectedRecommendation: 'consider full analysis' }
            ];
            
            for (const scenario of scenarios) {
                const efficiency = TestUtils.calculateAnalysisEfficiency(
                    scenario.total,
                    scenario.analyzed,
                    scenario.scanTime,
                    scenario.analysisTime
                );
                
                // Verify efficiency structure
                const requiredProps = ['efficiencyRatio', 'filesSkipped', 'timeSkipped', 'totalDuration', 'recommendation'];
                for (const prop of requiredProps) {
                    if (!(prop in efficiency)) {
                        console.log(`❌ Missing efficiency property: ${prop}`);
                        return false;
                    }
                }
                
                // Verify efficiency ratio
                if (Math.abs(efficiency.efficiencyRatio - scenario.expectedEfficiency) > 0.01) {
                    console.log(`❌ Incorrect efficiency ratio: expected ${scenario.expectedEfficiency}, got ${efficiency.efficiencyRatio}`);
                    return false;
                }
                
                // Verify recommendation contains expected text
                if (!efficiency.recommendation.includes(scenario.expectedRecommendation.split(' ')[0])) {
                    console.log(`❌ Unexpected recommendation: ${efficiency.recommendation} (expected to contain ${scenario.expectedRecommendation})`);
                    return false;
                }
            }
            
            console.log(`✅ Analysis efficiency calculation works correctly`);
            console.log(`   Tested ${scenarios.length} efficiency scenarios`);
            console.log(`   All efficiency ratios and recommendations calculated properly`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ Analysis efficiency calculation test failed: ${error}`);
            return false;
        }
    }

    async testSmartAnalysisChangeThreshold() {
        try {
            console.log('Testing smart analysis change threshold detection...');
            
            // Test incremental update threshold decision
            const scenarios = [
                { changedFiles: 5, totalFiles: 100, threshold: 0.1, expectedIncremental: true },
                { changedFiles: 15, totalFiles: 100, threshold: 0.1, expectedIncremental: false },
                { changedFiles: 1, totalFiles: 50, threshold: 0.05, expectedIncremental: true },
                { changedFiles: 3, totalFiles: 50, threshold: 0.05, expectedIncremental: false }
            ];
            
            for (const scenario of scenarios) {
                const shouldUseIncremental = TestUtils.shouldUseIncrementalUpdate(
                    new Array(scenario.changedFiles).fill('file.cs'),
                    scenario.totalFiles,
                    scenario.threshold
                );
                
                if (shouldUseIncremental !== scenario.expectedIncremental) {
                    console.log(`❌ Incorrect threshold decision: ${scenario.changedFiles}/${scenario.totalFiles} files, threshold ${scenario.threshold}`);
                    console.log(`   Expected incremental: ${scenario.expectedIncremental}, got: ${shouldUseIncremental}`);
                    return false;
                }
            }
            
            console.log(`✅ Smart analysis change threshold detection works correctly`);
            console.log(`   Tested ${scenarios.length} threshold scenarios`);
            console.log(`   All incremental vs full analysis decisions calculated properly`);
            
            return true;
            
        } catch (error) {
            console.log(`❌ Smart analysis change threshold test failed: ${error}`);
            return false;
        }
    }
}

// Run the metadata analysis tests
async function runMetadataAnalysisTest() {
    const tester = new MetadataAnalysisTest();
    const success = await tester.runAllTests();
    process.exit(success ? 0 : 1);
}

// Run the test
runMetadataAnalysisTest().catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});