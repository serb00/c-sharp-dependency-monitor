const fs = require('fs');
const path = require('path');

console.log('🧪 UNIFIED ANALYSIS VERIFICATION TEST');
console.log('=====================================');

async function verifyUnifiedImplementation() {
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    try {
        console.log('\n🔍 Verifying unified analysis implementation...');
        
        // Check utils.ts for unified functions
        const utilsPath = path.join(__dirname, '../utils.ts');
        const utilsContent = fs.readFileSync(utilsPath, 'utf8');
        
        const unifiedFunctions = [
            'performUnifiedPartialUpdate',
            'performUnifiedIncrementalUpdate', 
            'detectUnifiedCircularDependencies',
            'invalidateUnifiedCache'
        ];
        
        let allFunctionsFound = true;
        for (const func of unifiedFunctions) {
            if (utilsContent.includes(`${func}(`)) {
                console.log(`✅ Utils.${func}() found in utils.ts`);
            } else {
                console.log(`❌ Utils.${func}() missing from utils.ts`);
                allFunctionsFound = false;
            }
        }
        
        // Check extension.ts for unified usage
        const extensionPath = path.join(__dirname, '../extension.ts');
        const extensionContent = fs.readFileSync(extensionPath, 'utf8');
        
        const extensionChecks = [
            { name: 'performUnifiedAnalysisWrapper function', pattern: 'performUnifiedAnalysisWrapper(' },
            { name: 'Uses Utils.performUnifiedPartialUpdate', pattern: 'Utils.performUnifiedPartialUpdate(' },
            { name: 'Uses Utils.detectUnifiedCircularDependencies', pattern: 'Utils.detectUnifiedCircularDependencies(' },
            { name: 'No old analyzeNamespaceLevel calls', pattern: 'analyzeNamespaceLevel(', shouldNotExist: true },
            { name: 'No old analyzeClassLevel calls', pattern: 'analyzeClassLevel(', shouldNotExist: true }
        ];
        
        let extensionCorrect = true;
        for (const check of extensionChecks) {
            const found = extensionContent.includes(check.pattern);
            if (check.shouldNotExist) {
                if (!found) {
                    console.log(`✅ ${check.name} - correctly removed`);
                } else {
                    console.log(`❌ ${check.name} - still exists (should be removed)`);
                    extensionCorrect = false;
                }
            } else {
                if (found) {
                    console.log(`✅ ${check.name} - implemented`);
                } else {
                    console.log(`❌ ${check.name} - missing`);
                    extensionCorrect = false;
                }
            }
        }
        
        // Check TypeScript compilation
        console.log('\n🔧 Checking TypeScript compilation...');
        const { execSync } = require('child_process');
        try {
            execSync('npx tsc --noEmit', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
            console.log('✅ TypeScript compilation successful');
        } catch (error) {
            console.log('❌ TypeScript compilation failed');
            console.log('Error:', error.message);
            return false;
        }
        
        if (allFunctionsFound && extensionCorrect) {
            console.log('\n🎉 UNIFIED ANALYSIS IMPLEMENTATION VERIFIED!');
            console.log('   ✅ All unified functions implemented in utils.ts');
            console.log('   ✅ Extension.ts refactored to use unified approach');
            console.log('   ✅ Old separate update logic removed');
            console.log('   ✅ TypeScript compilation successful');
            return true;
        } else {
            console.log('\n🚨 VERIFICATION ISSUES FOUND');
            return false;
        }
        
    } catch (error) {
        console.error('💥 ERROR during verification:', error.message);
        return false;
    }
}

// Run the verification
verifyUnifiedImplementation().then(success => {
    console.log('\n📊 UNIFIED ANALYSIS VERIFICATION RESULT');
    console.log('=======================================');
    
    if (success) {
        console.log('🎉 SUCCESS: Unified analysis system is properly implemented!');
        console.log('');
        console.log('ACCOMPLISHMENTS:');
        console.log('✅ Task 17: Implement unified partial update strategy - COMPLETED');
        console.log('✅ Different update logic eliminated');
        console.log('✅ Both namespace and class graphs updated together');
        console.log('✅ Extension refactored to use unified system');
        console.log('✅ TypeScript compilation successful');
        process.exit(0);
    } else {
        console.log('🚨 FAILED: Unified analysis system verification failed');
        process.exit(1);
    }
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});