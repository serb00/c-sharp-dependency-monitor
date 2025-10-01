import { AutomatedTestRunner } from './automatedTestRunner';
import * as path from 'path';

// Simple test runner script
async function main() {
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`🚀 Starting tests from workspace: ${workspaceRoot}`);
    
    // Create test runner with console output
    const testRunner = new AutomatedTestRunner(workspaceRoot, {
        appendLine: (message: string) => console.log(message)
    });
    
    try {
        // Run quick validation first
        console.log('\n⚡ QUICK VALIDATION TEST');
        console.log('======================');
        const quickResult = await testRunner.runQuickValidation();
        
        if (quickResult) {
            console.log('\n🎉 Quick validation PASSED! Running full test suite...\n');
            
            // Run full test suite
            const fullResult = await testRunner.runAllTests();
            
            if (fullResult) {
                console.log('\n🎉 ALL TESTS PASSED! The dependency analysis fix is working correctly.');
                process.exit(0);
            } else {
                console.log('\n🚨 Some tests failed. See results above.');
                process.exit(1);
            }
        } else {
            console.log('\n🚨 Quick validation FAILED! The basic fix is not working.');
            process.exit(1);
        }
    } catch (error) {
        console.error('💥 ERROR during testing:', error);
        process.exit(1);
    }
}

// Run the tests
main().catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});