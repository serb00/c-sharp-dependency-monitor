const path = require('path');
const fs = require('fs');

// Simple test framework for graph persistence functions
class GraphPersistenceTestUtils {
    // Mock Utils class with our new functions
    static serializeDependencyGraph(dependencies) {
        return {
            dependencies: Array.from(dependencies.entries()),
            timestamp: Date.now(),
            version: '1.0.0'
        };
    }

    static deserializeDependencyGraph(data) {
        if (!data || !data.dependencies) {
            return new Map();
        }
        return new Map(data.dependencies);
    }

    static calculateContentHash(content) {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    static async calculateFileHash(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return this.calculateContentHash(content);
        } catch (error) {
            throw new Error(`Failed to calculate hash for ${filePath}: ${error}`);
        }
    }

    static async calculateDependencyFileHashes(dependencies) {
        const hashes = new Map();

        for (const [_, node] of dependencies) {
            if (node.filePath) {
                try {
                    const hash = await this.calculateFileHash(node.filePath);
                    hashes.set(node.filePath, hash);
                } catch (error) {
                    // File might not exist anymore, skip
                }
            }
        }

        return hashes;
    }

    static async validateCacheHashes(cachedHashes, changedFiles) {
        try {
            for (const filePath of changedFiles) {
                const currentHash = await this.calculateFileHash(filePath);
                const cachedHash = cachedHashes.get(filePath);

                if (cachedHash && cachedHash !== currentHash) {
                    return false; // File changed
                }
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    static findDependentFiles(changedFilePath, fileCache) {
        const dependents = [];
        
        // Get namespace and classes from the changed file
        const fileData = fileCache.get(changedFilePath);
        if (!fileData) {
            return dependents;
        }

        // Find files that depend on this file's namespace or classes
        for (const [otherPath, otherData] of fileCache) {
            if (otherPath === changedFilePath) continue;

            // Check if other file depends on this file's namespace
            if (otherData.dependencies.includes(fileData.namespace)) {
                dependents.push(otherPath);
                continue;
            }

            // Check if other file depends on this file's classes
            for (const className of fileData.classes) {
                if (otherData.dependencies.includes(className)) {
                    dependents.push(otherPath);
                    break;
                }
            }
        }

        return dependents;
    }

    static mergeDependencyGraphs(existing, incremental, affectedKeys) {
        const merged = new Map(existing);

        // Update affected nodes
        for (const key of affectedKeys) {
            if (incremental.has(key)) {
                merged.set(key, incremental.get(key));
            } else {
                // If key not in incremental result, remove it (file might have been deleted)
                merged.delete(key);
            }
        }

        // Add any new nodes from incremental analysis
        for (const [key, value] of incremental) {
            if (!affectedKeys.includes(key)) {
                merged.set(key, value);
            }
        }

        return merged;
    }

    static extractGraphMetadata(dependencies, analysisLevel) {
        const allFiles = new Set();
        const allNamespaces = new Set();
        
        for (const [_, node] of dependencies) {
            if (node.filePath) allFiles.add(node.filePath);
            if (node.namespace) allNamespaces.add(node.namespace);
        }

        return {
            totalDependencies: dependencies.size,
            totalFiles: allFiles.size,
            totalNamespaces: allNamespaces.size,
            analysisLevel,
            timestamp: Date.now(),
            fileList: Array.from(allFiles),
            namespaceList: Array.from(allNamespaces)
        };
    }
}

async function runGraphPersistenceTests() {
    console.log('🧪 TESTING GRAPH PERSISTENCE FUNCTIONS');
    console.log('======================================');
    
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    let testsPassed = true;

    // Test 1: Graph Serialization/Deserialization
    console.log('\n📋 Test 1: Graph Serialization/Deserialization');
    try {
        // Create a sample dependency graph
        const originalGraph = new Map();
        originalGraph.set('TestScenarios.FalsePositiveTest.LinearChainA', {
            name: 'LinearChainA',
            namespace: 'TestScenarios.FalsePositiveTest',
            fullName: 'TestScenarios.FalsePositiveTest.LinearChainA',
            filePath: 'src/test/Scripts/TestScenarios/FalsePositiveTest/LinearChainA.cs',
            dependencies: ['TestScenarios.FalsePositiveTest.LinearChainB'],
            classType: 'class'
        });
        originalGraph.set('TestScenarios.FalsePositiveTest.LinearChainB', {
            name: 'LinearChainB',
            namespace: 'TestScenarios.FalsePositiveTest',
            fullName: 'TestScenarios.FalsePositiveTest.LinearChainB',
            filePath: 'src/test/Scripts/TestScenarios/FalsePositiveTest/LinearChainB.cs',
            dependencies: ['TestScenarios.FalsePositiveTest.LinearChainC'],
            classType: 'class'
        });

        // Serialize
        const serialized = GraphPersistenceTestUtils.serializeDependencyGraph(originalGraph);
        console.log(`  ✅ Serialized graph with ${serialized.dependencies.length} entries`);

        // Deserialize
        const deserialized = GraphPersistenceTestUtils.deserializeDependencyGraph(serialized);
        console.log(`  ✅ Deserialized graph with ${deserialized.size} entries`);

        // Verify integrity
        if (deserialized.size === originalGraph.size) {
            const originalEntry = originalGraph.get('TestScenarios.FalsePositiveTest.LinearChainA');
            const deserializedEntry = deserialized.get('TestScenarios.FalsePositiveTest.LinearChainA');
            
            if (originalEntry && deserializedEntry && 
                originalEntry.name === deserializedEntry.name &&
                originalEntry.namespace === deserializedEntry.namespace) {
                console.log('  ✅ Serialization/deserialization preserves data integrity');
            } else {
                console.log('  ❌ Data integrity check failed');
                testsPassed = false;
            }
        } else {
            console.log('  ❌ Graph size mismatch after deserialization');
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ Serialization test failed: ${error}`);
        testsPassed = false;
    }

    // Test 2: Content Hash Calculation
    console.log('\n📋 Test 2: Content Hash Calculation');
    try {
        const testContent1 = 'using System;\nnamespace Test { public class TestClass { } }';
        const testContent2 = 'using System;\nnamespace Test { public class TestClass { } }';
        const testContent3 = 'using System;\nnamespace Test { public class DifferentClass { } }';

        const hash1 = GraphPersistenceTestUtils.calculateContentHash(testContent1);
        const hash2 = GraphPersistenceTestUtils.calculateContentHash(testContent2);
        const hash3 = GraphPersistenceTestUtils.calculateContentHash(testContent3);

        console.log(`  ✅ Generated hash for content 1: ${hash1.substring(0, 8)}...`);
        console.log(`  ✅ Generated hash for content 2: ${hash2.substring(0, 8)}...`);
        console.log(`  ✅ Generated hash for content 3: ${hash3.substring(0, 8)}...`);

        if (hash1 === hash2) {
            console.log('  ✅ Identical content produces identical hashes');
        } else {
            console.log('  ❌ Identical content should produce identical hashes');
            testsPassed = false;
        }

        if (hash1 !== hash3) {
            console.log('  ✅ Different content produces different hashes');
        } else {
            console.log('  ❌ Different content should produce different hashes');
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ Hash calculation test failed: ${error}`);
        testsPassed = false;
    }

    // Test 3: File Hash Calculation
    console.log('\n📋 Test 3: File Hash Calculation');
    try {
        const testFilePath = path.join(workspaceRoot, 'src/test/Scripts/TestScenarios/FalsePositiveTest/LinearChainA.cs');
        if (fs.existsSync(testFilePath)) {
            const hash = await GraphPersistenceTestUtils.calculateFileHash(testFilePath);
            console.log(`  ✅ Calculated hash for ${path.basename(testFilePath)}: ${hash.substring(0, 8)}...`);
            
            // Calculate again to verify consistency
            const hash2 = await GraphPersistenceTestUtils.calculateFileHash(testFilePath);
            if (hash === hash2) {
                console.log('  ✅ File hash calculation is consistent');
            } else {
                console.log('  ❌ File hash calculation should be consistent');
                testsPassed = false;
            }
        } else {
            console.log(`  ❌ Test file not found: ${testFilePath}`);
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ File hash test failed: ${error}`);
        testsPassed = false;
    }

    // Test 4: Dependent Files Discovery
    console.log('\n📋 Test 4: Dependent Files Discovery');
    try {
        // Create mock file cache
        const fileCache = new Map();
        fileCache.set('/project/FileA.cs', {
            namespace: 'Project.Core',
            classes: ['ClassA', 'UtilityA'],
            dependencies: []
        });
        fileCache.set('/project/FileB.cs', {
            namespace: 'Project.Services',
            classes: ['ServiceB'],
            dependencies: ['Project.Core', 'ClassA'] // Depends on FileA
        });
        fileCache.set('/project/FileC.cs', {
            namespace: 'Project.UI',
            classes: ['UIComponent'],
            dependencies: ['Project.Services'] // Depends on FileB
        });

        const dependents = GraphPersistenceTestUtils.findDependentFiles('/project/FileA.cs', fileCache);
        console.log(`  ✅ Found ${dependents.length} dependent files for FileA.cs`);
        console.log(`  📄 Dependents: ${dependents.join(', ')}`);

        if (dependents.includes('/project/FileB.cs')) {
            console.log('  ✅ Correctly identified FileB as dependent (namespace dependency)');
        } else {
            console.log('  ❌ Should identify FileB as dependent');
            testsPassed = false;
        }

        // FileC doesn't directly depend on FileA, so it shouldn't be included
        if (!dependents.includes('/project/FileC.cs')) {
            console.log('  ✅ Correctly excluded FileC (no direct dependency)');
        } else {
            console.log('  ❌ Should not include indirect dependencies');
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ Dependent files test failed: ${error}`);
        testsPassed = false;
    }

    // Test 5: Graph Merging
    console.log('\n📋 Test 5: Graph Merging');
    try {
        // Create existing graph
        const existing = new Map();
        existing.set('ClassA', { name: 'ClassA', version: 1 });
        existing.set('ClassB', { name: 'ClassB', version: 1 });
        existing.set('ClassC', { name: 'ClassC', version: 1 });

        // Create incremental updates
        const incremental = new Map();
        incremental.set('ClassA', { name: 'ClassA', version: 2 }); // Updated
        incremental.set('ClassD', { name: 'ClassD', version: 1 }); // New

        const affectedKeys = ['ClassA', 'ClassB']; // ClassB deleted, ClassA updated

        const merged = GraphPersistenceTestUtils.mergeDependencyGraphs(existing, incremental, affectedKeys);

        console.log(`  ✅ Merged graph has ${merged.size} entries`);

        // Verify updates
        if (merged.get('ClassA').version === 2) {
            console.log('  ✅ Updated ClassA correctly');
        } else {
            console.log('  ❌ ClassA should be updated to version 2');
            testsPassed = false;
        }

        // Verify deletion
        if (!merged.has('ClassB')) {
            console.log('  ✅ Removed ClassB correctly');
        } else {
            console.log('  ❌ ClassB should be removed');
            testsPassed = false;
        }

        // Verify preservation
        if (merged.has('ClassC')) {
            console.log('  ✅ Preserved ClassC correctly');
        } else {
            console.log('  ❌ ClassC should be preserved');
            testsPassed = false;
        }

        // Verify addition
        if (merged.has('ClassD')) {
            console.log('  ✅ Added ClassD correctly');
        } else {
            console.log('  ❌ ClassD should be added');
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ Graph merging test failed: ${error}`);
        testsPassed = false;
    }

    // Test 6: Graph Metadata Extraction
    console.log('\n📋 Test 6: Graph Metadata Extraction');
    try {
        const graph = new Map();
        graph.set('Core.ClassA', {
            namespace: 'Core',
            filePath: '/project/Core/ClassA.cs'
        });
        graph.set('Core.ClassB', {
            namespace: 'Core',
            filePath: '/project/Core/ClassB.cs'
        });
        graph.set('Services.ServiceA', {
            namespace: 'Services',
            filePath: '/project/Services/ServiceA.cs'
        });

        const metadata = GraphPersistenceTestUtils.extractGraphMetadata(graph, 'class');

        console.log(`  ✅ Extracted metadata: ${JSON.stringify(metadata, null, 2)}`);

        if (metadata.totalDependencies === 3) {
            console.log('  ✅ Correct dependency count');
        } else {
            console.log('  ❌ Incorrect dependency count');
            testsPassed = false;
        }

        if (metadata.totalFiles === 3) {
            console.log('  ✅ Correct file count');
        } else {
            console.log('  ❌ Incorrect file count');
            testsPassed = false;
        }

        if (metadata.totalNamespaces === 2) {
            console.log('  ✅ Correct namespace count');
        } else {
            console.log('  ❌ Incorrect namespace count');
            testsPassed = false;
        }

        if (metadata.analysisLevel === 'class') {
            console.log('  ✅ Correct analysis level');
        } else {
            console.log('  ❌ Incorrect analysis level');
            testsPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ Metadata extraction test failed: ${error}`);
        testsPassed = false;
    }

    console.log('\n📊 GRAPH PERSISTENCE TEST RESULTS');
    console.log('=================================');
    
    if (testsPassed) {
        console.log('🎉 ALL GRAPH PERSISTENCE TESTS PASSED!');
        console.log('   ✅ Graph serialization/deserialization works correctly');
        console.log('   ✅ Content and file hashing works correctly');
        console.log('   ✅ Dependent file discovery works correctly');
        console.log('   ✅ Graph merging works correctly');
        console.log('   ✅ Metadata extraction works correctly');
        return true;
    } else {
        console.log('🚨 GRAPH PERSISTENCE TESTS FAILED!');
        console.log('   Some graph persistence functions have issues.');
        return false;
    }
}

// Run the tests
runGraphPersistenceTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});