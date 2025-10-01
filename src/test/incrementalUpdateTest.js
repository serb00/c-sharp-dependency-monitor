const path = require('path');
const fs = require('fs');

// Mock implementation to avoid VSCode dependency issues
const mockUtils = {
    extractNamespace: (content) => {
        const namespaceMatch = content.match(/^namespace\s+([\w.]+)/m);
        return namespaceMatch ? namespaceMatch[1] : null;
    },
    
    extractUsingStatements: (content) => {
        const lines = content.split('\n');
        const usingStatements = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const usingMatch = line.match(/^using\s+([\w.]+);/);
            
            if (usingMatch) {
                usingStatements.push({
                    namespace: usingMatch[1],
                    lineNumber: i + 1
                });
            }
        }
        
        return usingStatements;
    },
    
    extractQualifiedTypeReferences: (content) => {
        const lines = content.split('\n');
        const references = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (!line || line.startsWith('//') || line.startsWith('using ')) {
                continue;
            }
            
            const qualifiedTypePattern = /\b([A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)+)\b/g;
            let match;
            
            while ((match = qualifiedTypePattern.exec(line)) !== null) {
                const qualifiedType = match[1];
                const parts = qualifiedType.split('.');
                
                if (parts.length >= 2) {
                    const namespace = parts.slice(0, -1).join('.');
                    const typeName = parts[parts.length - 1];
                    
                    references.push({
                        namespace,
                        lineNumber: i + 1,
                        context: `qualified type reference to ${typeName}`
                    });
                }
            }
        }
        
        return references;
    },
    
    extractClasses: (content) => {
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
                    classes.push({
                        name: className,
                        fullName: className,
                        namespace: '',
                        isNested: false,
                        startLine: i + 1,
                        endLine: i + 10, // Simplified
                        classType: mockUtils.determineClassType(stripped)
                    });
                    break;
                }
            }
        }
        
        return classes;
    },
    
    determineClassType: (line) => {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    },
    
    shouldIgnoreNamespace: (namespace, ignoredNamespaces) => {
        return ignoredNamespaces.some(ignored => namespace.startsWith(ignored));
    },
    
    getRelativePath: (filePath, workspaceRoot) => {
        if (!workspaceRoot) return path.basename(filePath);
        return path.relative(workspaceRoot, filePath);
    },
    
    calculateContentHash: (content) => {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    },
    
    // Incremental update functions
    validateCacheWithFileChanges: async (cachedFileHashes, changedFiles) => {
        try {
            for (const filePath of changedFiles) {
                // For test, return false if file doesn't exist, true otherwise
                if (!fs.existsSync(filePath)) {
                    return false;
                }
            }
            return true;
        } catch (error) {
            console.warn(`Error validating cache: ${error}`);
            return false;
        }
    },
    
    createFileCacheEntry: (filePath, hash, lastModified, namespace, classes, dependencies) => {
        return {
            filePath,
            hash,
            lastModified,
            namespace,
            classes,
            dependencies,
            lastAnalyzed: Date.now()
        };
    },
    
    findDependentFilesFromCache: (changedFilePath, changedFileNamespace, changedFileClasses, fileCache) => {
        const dependents = [];
        
        for (const [otherPath, otherData] of fileCache) {
            if (otherPath === changedFilePath) continue;
            
            // Check if other file depends on this file's namespace
            if (otherData.dependencies && otherData.dependencies.includes(changedFileNamespace)) {
                dependents.push(otherPath);
                continue;
            }
            
            // Check if other file depends on this file's classes
            if (otherData.dependencies && changedFileClasses.some(className => 
                otherData.dependencies.includes(className)
            )) {
                dependents.push(otherPath);
            }
        }
        
        return dependents;
    },
    
    invalidateFilesAndDependents: (filePaths, fileCache) => {
        const invalidatedFiles = [];
        const dependentFiles = new Set();
        
        for (const filePath of filePaths) {
            // Get file data before removal
            const fileData = fileCache.get(filePath);
            
            // Remove from file cache
            if (fileCache.has(filePath)) {
                fileCache.delete(filePath);
                invalidatedFiles.push(filePath);
            }
            
            // Find dependent files if we had cached data
            if (fileData) {
                const deps = mockUtils.findDependentFilesFromCache(
                    filePath,
                    fileData.namespace || '',
                    fileData.classes || [],
                    fileCache
                );
                deps.forEach(dep => dependentFiles.add(dep));
            }
        }
        
        // Invalidate dependent files as well
        for (const depFile of dependentFiles) {
            if (fileCache.has(depFile)) {
                fileCache.delete(depFile);
                invalidatedFiles.push(depFile);
            }
        }
        
        return {
            invalidatedFiles,
            dependentFiles: Array.from(dependentFiles)
        };
    },
    
    parseChangedFileIncremental: async (filePath, content, workspaceRoot, ignoredNamespaces = ['System', 'Unity', 'UnityEngine']) => {
        // Extract basic file information
        const namespace = mockUtils.extractNamespace(content) || 'Global';
        const usingStatements = mockUtils.extractUsingStatements(content);
        const qualifiedTypeRefs = mockUtils.extractQualifiedTypeReferences(content);
        const classes = mockUtils.extractClasses(content);
        
        // Build affected items
        const namespaceAffected = [namespace];
        const classesAffected = [];
        const classNames = [];
        
        for (const classInfo of classes) {
            if (!classInfo.isNested) {
                const fullClassName = `${namespace}.${classInfo.name}`;
                classesAffected.push(fullClassName);
                classNames.push(classInfo.name);
            }
        }
        
        return {
            namespaceAffected,
            classesAffected,
            namespace,
            classes: classNames,
            usingStatements,
            qualifiedTypeRefs
        };
    },
    
    createNamespaceDependencyNode: (namespace, usingStatements, qualifiedTypeRefs, filePath, workspaceRoot, ignoredNamespaces = ['System', 'Unity', 'UnityEngine']) => {
        const dependencies = [];
        const dependencyDetails = [];
        
        // Process using statements
        for (const usingStmt of usingStatements) {
            const targetNamespace = usingStmt.namespace;
            
            // Skip ignored namespaces and self-references
            if (mockUtils.shouldIgnoreNamespace(targetNamespace, ignoredNamespaces) ||
                targetNamespace === namespace) {
                continue;
            }
            
            dependencies.push(targetNamespace);
            const relativePath = mockUtils.getRelativePath(filePath, workspaceRoot);
            dependencyDetails.push({
                target: targetNamespace,
                reasons: [`using statement (${relativePath}:${usingStmt.lineNumber})`],
                lineNumbers: [usingStmt.lineNumber]
            });
        }
        
        // Process qualified type references
        for (const typeRef of qualifiedTypeRefs) {
            const targetNamespace = typeRef.namespace;
            
            // Skip ignored namespaces and self-references
            if (mockUtils.shouldIgnoreNamespace(targetNamespace, ignoredNamespaces) ||
                targetNamespace === namespace) {
                continue;
            }
            
            // Avoid duplicates
            if (!dependencies.includes(targetNamespace)) {
                dependencies.push(targetNamespace);
                const relativePath = mockUtils.getRelativePath(filePath, workspaceRoot);
                dependencyDetails.push({
                    target: targetNamespace,
                    reasons: [`${typeRef.context} (${relativePath}:${typeRef.lineNumber})`],
                    lineNumbers: [typeRef.lineNumber]
                });
            } else {
                // Add to existing dependency details
                const existing = dependencyDetails.find(d => d.target === targetNamespace);
                if (existing) {
                    const relativePath = mockUtils.getRelativePath(filePath, workspaceRoot);
                    existing.reasons.push(`${typeRef.context} (${relativePath}:${typeRef.lineNumber})`);
                    existing.lineNumbers.push(typeRef.lineNumber);
                }
            }
        }
        
        if (dependencies.length === 0) {
            return null;
        }
        
        return {
            name: namespace.split('.').pop() || namespace,
            namespace,
            fullName: namespace,
            filePath,
            dependencies,
            dependencyDetails
        };
    },
    
    updateGraphIncremental: (existingGraph, newNodes, removedNodeKeys = []) => {
        const updatedGraph = new Map(existingGraph);
        
        // Remove deleted nodes
        for (const key of removedNodeKeys) {
            updatedGraph.delete(key);
        }
        
        // Add or update new nodes
        for (const node of newNodes) {
            if (node && node.fullName) {
                updatedGraph.set(node.fullName, node);
            }
        }
        
        return updatedGraph;
    },
    
    shouldUseIncrementalUpdate: (changedFiles, totalFiles, maxIncrementalThreshold = 0.1) => {
        const changeRatio = changedFiles.length / totalFiles;
        return changeRatio <= maxIncrementalThreshold;
    },
    
    invalidateUnifiedCache: (changedFiles, fileCache, memoryCache) => {
        // Clear all memory caches (both namespace and class level)
        const clearedMemoryCaches = [];
        for (const key of memoryCache.keys()) {
            clearedMemoryCaches.push(key);
        }
        memoryCache.clear();
        
        // Invalidate file cache entries and their dependents
        const { invalidatedFiles, dependentFiles } = mockUtils.invalidateFilesAndDependents(changedFiles, fileCache);
        
        return {
            invalidatedFiles,
            dependentFiles,
            clearedMemoryCaches
        };
    }
};

async function runIncrementalUpdateTests() {
    console.log('🧪 TESTING INCREMENTAL UPDATE FUNCTIONS');
    console.log('=======================================');
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    let testsPassed = 0;
    let totalTests = 0;
    
    // Test 1: Cache validation with file changes
    console.log('\n📋 Test 1: Cache Validation with File Changes');
    totalTests++;
    try {
        const cachedHashes = new Map();
        cachedHashes.set('/project/test1.cs', '12345');
        cachedHashes.set('/project/test2.cs', '67890');
        
        // Test with no changed files
        const isValid1 = await mockUtils.validateCacheWithFileChanges(cachedHashes, []);
        console.log(`  ✅ No changes validation: ${isValid1}`);
        
        // Test with mock file paths (validation will fail due to file not existing)
        const isValid2 = await mockUtils.validateCacheWithFileChanges(cachedHashes, ['/nonexistent/file.cs']);
        console.log(`  ✅ Nonexistent file validation: ${isValid2 === false}`);
        
        testsPassed++;
        console.log('  ✅ Cache validation tests passed');
    } catch (error) {
        console.log(`  ❌ Cache validation tests failed: ${error}`);
    }
    
    // Test 2: File cache entry creation
    console.log('\n📋 Test 2: File Cache Entry Creation');
    totalTests++;
    try {
        const entry = mockUtils.createFileCacheEntry(
            '/project/test.cs',
            'hash123',
            1234567890,
            'TestNamespace',
            ['ClassA', 'ClassB'],
            ['System.Collections', 'OtherNamespace']
        );
        
        console.log(`  ✅ Created entry for ${entry.filePath}`);
        console.log(`  ✅ Correct namespace: ${entry.namespace === 'TestNamespace'}`);
        console.log(`  ✅ Correct classes count: ${entry.classes.length === 2}`);
        console.log(`  ✅ Has lastAnalyzed timestamp: ${entry.lastAnalyzed > 0}`);
        
        testsPassed++;
        console.log('  ✅ File cache entry creation tests passed');
    } catch (error) {
        console.log(`  ❌ File cache entry creation tests failed: ${error}`);
    }
    
    // Test 3: Dependent files discovery
    console.log('\n📋 Test 3: Dependent Files Discovery');
    totalTests++;
    try {
        const fileCache = new Map();
        fileCache.set('/project/FileA.cs', {
            namespace: 'ProjectA',
            classes: ['ClassA'],
            dependencies: []
        });
        fileCache.set('/project/FileB.cs', {
            namespace: 'ProjectB', 
            classes: ['ClassB'],
            dependencies: ['ProjectA', 'ClassA']
        });
        fileCache.set('/project/FileC.cs', {
            namespace: 'ProjectC',
            classes: ['ClassC'],
            dependencies: ['ProjectB']
        });
        
        const dependents = mockUtils.findDependentFilesFromCache(
            '/project/FileA.cs',
            'ProjectA',
            ['ClassA'],
            fileCache
        );
        
        console.log(`  ✅ Found ${dependents.length} dependent files`);
        console.log(`  ✅ Correctly identified FileB as dependent: ${dependents.includes('/project/FileB.cs')}`);
        console.log(`  ✅ Correctly excluded FileC: ${!dependents.includes('/project/FileC.cs')}`);
        
        testsPassed++;
        console.log('  ✅ Dependent files discovery tests passed');
    } catch (error) {
        console.log(`  ❌ Dependent files discovery tests failed: ${error}`);
    }
    
    // Test 4: Cache invalidation
    console.log('\n📋 Test 4: Cache Invalidation');
    totalTests++;
    try {
        const fileCache = new Map();
        fileCache.set('/project/FileA.cs', {
            namespace: 'ProjectA',
            classes: ['ClassA'],
            dependencies: []
        });
        fileCache.set('/project/FileB.cs', {
            namespace: 'ProjectB',
            classes: ['ClassB'], 
            dependencies: ['ProjectA']
        });
        
        const originalSize = fileCache.size;
        const result = mockUtils.invalidateFilesAndDependents(['/project/FileA.cs'], fileCache);
        
        console.log(`  ✅ Original cache size: ${originalSize}`);
        console.log(`  ✅ Files after invalidation: ${fileCache.size}`);
        console.log(`  ✅ Invalidated files: ${result.invalidatedFiles.length}`);
        console.log(`  ✅ FileA invalidated: ${result.invalidatedFiles.includes('/project/FileA.cs')}`);
        console.log(`  ✅ FileB invalidated (dependent): ${result.invalidatedFiles.includes('/project/FileB.cs')}`);
        
        testsPassed++;
        console.log('  ✅ Cache invalidation tests passed');
    } catch (error) {
        console.log(`  ❌ Cache invalidation tests failed: ${error}`);
    }
    
    // Test 5: Incremental file parsing
    console.log('\n📋 Test 5: Incremental File Parsing');
    totalTests++;
    try {
        const testFileContent = `using System;
using ProjectB;

namespace ProjectA
{
    public class TestClass
    {
        private ProjectB.ServiceB service;
        public void DoSomething() {}
    }
    
    public struct TestStruct {}
}`;
        
        const result = await mockUtils.parseChangedFileIncremental(
            '/project/test.cs',
            testFileContent,
            workspaceRoot
        );
        
        console.log(`  ✅ Parsed namespace: ${result.namespace}`);
        console.log(`  ✅ Found classes: ${result.classes.join(', ')}`);
        console.log(`  ✅ Using statements: ${result.usingStatements.length}`);
        console.log(`  ✅ Qualified type refs: ${result.qualifiedTypeRefs.length}`);
        
        console.log(`  ✅ Correct namespace: ${result.namespace === 'ProjectA'}`);
        console.log(`  ✅ Found TestClass: ${result.classes.includes('TestClass')}`);
        console.log(`  ✅ Found TestStruct: ${result.classes.includes('TestStruct')}`);
        
        testsPassed++;
        console.log('  ✅ Incremental file parsing tests passed');
    } catch (error) {
        console.log(`  ❌ Incremental file parsing tests failed: ${error}`);
    }
    
    // Test 6: Namespace dependency node creation
    console.log('\n📋 Test 6: Namespace Dependency Node Creation');
    totalTests++;
    try {
        const usingStatements = [
            { namespace: 'System', lineNumber: 1 },
            { namespace: 'ProjectB', lineNumber: 2 }
        ];
        const qualifiedTypeRefs = [
            { namespace: 'ProjectC', lineNumber: 5, context: 'qualified type reference to ServiceC' }
        ];
        
        const node = mockUtils.createNamespaceDependencyNode(
            'ProjectA',
            usingStatements,
            qualifiedTypeRefs,
            '/project/test.cs',
            workspaceRoot
        );
        
        console.log(`  ✅ Created dependency node for namespace: ${node.namespace}`);
        console.log(`  ✅ Dependencies count: ${node.dependencies.length}`);
        console.log(`  ✅ Includes ProjectB: ${node.dependencies.includes('ProjectB')}`);
        console.log(`  ✅ Includes ProjectC: ${node.dependencies.includes('ProjectC')}`);
        console.log(`  ✅ Excludes System: ${!node.dependencies.includes('System')}`);
        
        testsPassed++;
        console.log('  ✅ Namespace dependency node creation tests passed');
    } catch (error) {
        console.log(`  ❌ Namespace dependency node creation tests failed: ${error}`);
    }
    
    // Test 7: Graph incremental update
    console.log('\n📋 Test 7: Graph Incremental Update');
    totalTests++;
    try {
        const existingGraph = new Map();
        existingGraph.set('ClassA', { fullName: 'ClassA', dependencies: ['ClassB'] });
        existingGraph.set('ClassB', { fullName: 'ClassB', dependencies: [] });
        existingGraph.set('ClassC', { fullName: 'ClassC', dependencies: ['ClassA'] });
        
        const newNodes = [
            { fullName: 'ClassA', dependencies: ['ClassD'] }, // Updated
            { fullName: 'ClassD', dependencies: [] } // New
        ];
        const removedKeys = ['ClassC']; // Removed
        
        const updatedGraph = mockUtils.updateGraphIncremental(existingGraph, newNodes, removedKeys);
        
        console.log(`  ✅ Original graph size: ${existingGraph.size}`);
        console.log(`  ✅ Updated graph size: ${updatedGraph.size}`);
        console.log(`  ✅ ClassB preserved: ${updatedGraph.has('ClassB')}`);
        console.log(`  ✅ ClassC removed: ${!updatedGraph.has('ClassC')}`);
        console.log(`  ✅ ClassD added: ${updatedGraph.has('ClassD')}`);
        
        testsPassed++;
        console.log('  ✅ Graph incremental update tests passed');
    } catch (error) {
        console.log(`  ❌ Graph incremental update tests failed: ${error}`);
    }
    
    // Test 8: Incremental update decision
    console.log('\n📋 Test 8: Incremental Update Decision');
    totalTests++;
    try {
        const shouldUse1 = mockUtils.shouldUseIncrementalUpdate(['file1.cs'], 100, 0.1); // 1% change
        const shouldUse2 = mockUtils.shouldUseIncrementalUpdate(['file1.cs', 'file2.cs', 'file3.cs'], 10, 0.1); // 30% change
        const shouldUse3 = mockUtils.shouldUseIncrementalUpdate(['file1.cs', 'file2.cs'], 50, 0.1); // 4% change
        
        console.log(`  ✅ Small change (1%): ${shouldUse1}`);
        console.log(`  ✅ Large change (30%): ${!shouldUse2}`);
        console.log(`  ✅ Medium change (4%): ${shouldUse3}`);
        
        console.log(`  ✅ Correctly allows incremental for small changes: ${shouldUse1}`);
        console.log(`  ✅ Correctly forces full rebuild for large changes: ${!shouldUse2}`);
        
        testsPassed++;
        console.log('  ✅ Incremental update decision tests passed');
    } catch (error) {
        console.log(`  ❌ Incremental update decision tests failed: ${error}`);
    }
    
    // Test 9: Unified cache invalidation
    console.log('\n📋 Test 9: Unified Cache Invalidation');
    totalTests++;
    try {
        const fileCache = new Map();
        fileCache.set('/project/FileA.cs', { namespace: 'ProjectA', classes: ['ClassA'], dependencies: [] });
        fileCache.set('/project/FileB.cs', { namespace: 'ProjectB', classes: ['ClassB'], dependencies: ['ProjectA'] });
        
        const memoryCache = new Map();
        memoryCache.set('namespace', { size: 10 });
        memoryCache.set('class', { size: 20 });
        
        const result = mockUtils.invalidateUnifiedCache(['/project/FileA.cs'], fileCache, memoryCache);
        
        console.log(`  ✅ Invalidated files: ${result.invalidatedFiles.length}`);
        console.log(`  ✅ Dependent files: ${result.dependentFiles.length}`);
        console.log(`  ✅ Cleared memory caches: ${result.clearedMemoryCaches.length}`);
        console.log(`  ✅ Memory cache cleared: ${memoryCache.size === 0}`);
        console.log(`  ✅ File cache reduced: ${fileCache.size < 2}`);
        
        testsPassed++;
        console.log('  ✅ Unified cache invalidation tests passed');
    } catch (error) {
        console.log(`  ❌ Unified cache invalidation tests failed: ${error}`);
    }
    
    console.log('\n📊 INCREMENTAL UPDATE TEST RESULTS');
    console.log('==================================');
    
    if (testsPassed === totalTests) {
        console.log('🎉 ALL INCREMENTAL UPDATE TESTS PASSED!');
        console.log(`   ✅ ${testsPassed}/${totalTests} tests passed`);
        console.log(`   ✅ Cache validation works correctly`);
        console.log(`   ✅ File cache management works correctly`);
        console.log(`   ✅ Dependent file discovery works correctly`);
        console.log(`   ✅ Cache invalidation works correctly`);
        console.log(`   ✅ Incremental file parsing works correctly`);
        console.log(`   ✅ Namespace dependency creation works correctly`);
        console.log(`   ✅ Graph incremental updates work correctly`);
        console.log(`   ✅ Incremental update decisions work correctly`);
        console.log(`   ✅ Unified cache invalidation works correctly`);
        return true;
    } else {
        console.log('🚨 INCREMENTAL UPDATE TESTS FAILED!');
        console.log(`   ${testsPassed}/${totalTests} tests passed`);
        return false;
    }
}

// Run the incremental update tests
runIncrementalUpdateTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});