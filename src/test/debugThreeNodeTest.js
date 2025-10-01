const { StandaloneDependencyAnalyzer } = require('./standaloneDependencyAnalyzer');
const path = require('path');

async function debugAnalyzer() {
    console.log('🔍 Debug: Testing analyzer with TestScenarios...');
    
    const workspaceRoot = path.resolve(__dirname, '../..');
    const analyzer = new StandaloneDependencyAnalyzer({
        appendLine: (message) => {
            if (message.includes('DEBUG') || message.includes('Found')) {
                console.log(message);
            }
        }
    });
    
    try {
        const dependencies = await analyzer.analyzeClassDependencies(workspaceRoot);
        
        console.log('\n📊 ANALYSIS RESULTS');
        console.log('==================');
        console.log('Total classes found:', dependencies.size);
        
        // Show all found classes that match our test scenarios
        console.log('\n🔍 TestScenarios Classes:');
        for (const [className, dep] of dependencies) {
            if (className.includes('TestScenarios')) {
                console.log('✅ Found:', className);
                console.log('   Dependencies:', dep.dependencies);
                console.log('   File:', path.relative(workspaceRoot, dep.filePath));
            }
        }
        
        // Check specific files manually
        const testFiles = [
            'TestScenarios.ThreeNodeCircular.ServiceA',
            'TestScenarios.ThreeNodeCircular.ServiceB', 
            'TestScenarios.ThreeNodeCircular.ServiceC'
        ];
        
        console.log('\n🧪 SPECIFIC TEST CLASS CHECK');
        console.log('============================');
        for (const testClass of testFiles) {
            const found = dependencies.has(testClass);
            console.log(`${found ? '✅' : '❌'} ${testClass}: ${found ? 'FOUND' : 'NOT FOUND'}`);
            if (found) {
                const dep = dependencies.get(testClass);
                console.log(`   Dependencies: [${dep.dependencies.join(', ')}]`);
            }
        }
        
        return dependencies;
        
    } catch (error) {
        console.error('Error during analysis:', error);
        return null;
    }
}

debugAnalyzer().catch(console.error);