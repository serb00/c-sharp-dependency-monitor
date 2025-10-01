import * as path from 'path';
import { DependencyAnalyzer } from '../dependencyAnalyzer';
import { CircularDependencyDetector } from '../circularDependencyDetector';
import { ConfigManager } from '../configManager';
import { AnalysisResult } from '../types';

interface TestCase {
    name: string;
    description: string;
    expectedCircularDependencies: string[];
    expectedDependencies: { [key: string]: string[] };
    testFunction: () => Promise<boolean>;
}

export class AutomatedTestRunner {
    private analyzer: DependencyAnalyzer;
    private circularDetector: CircularDependencyDetector;
    private workspaceRoot: string;
    private testScriptsPath: string;
    private outputChannel: any;

    constructor(workspaceRoot: string, outputChannel?: any) {
        this.workspaceRoot = workspaceRoot;
        this.testScriptsPath = path.join(workspaceRoot, 'src/test/Scripts');
        this.outputChannel = outputChannel || {
            appendLine: (message: string) => console.log(message)
        };
        this.analyzer = new DependencyAnalyzer(this.outputChannel);
        this.circularDetector = new CircularDependencyDetector();
        
        // Configure for test scripts path
        const configManager = ConfigManager.getInstance();
        const config = configManager.getConfig();
        config.projectPaths = ['src/test/Scripts'];
        // Note: Config will be properly set during tests
    }

    private log(message: string) {
        this.outputChannel.appendLine(`🧪 TEST: ${message}`);
    }

    async runAllTests(): Promise<boolean> {
        this.log('🚀 Starting Automated Dependency Analysis Testing');
        this.log('================================================');

        const testCases: TestCase[] = [
            {
                name: 'GameConstants ↔ FindTargetSystem Circular Dependency',
                description: 'Test the core circular dependency between GameConstants and FindTargetSystem',
                expectedCircularDependencies: [
                    'Core.GameConstants → Combat.FindTargetSystem → Core.GameConstants'
                ],
                expectedDependencies: {
                    'Core.GameConstants': ['Combat.FindTargetSystem'],
                    'Combat.FindTargetSystem': ['Core.GameConstants', 'Ships.Ship', 'Ships.Health']
                },
                testFunction: () => this.testGameConstantsCircularDependency()
            },
            {
                name: 'Ships Dependencies Validation',
                description: 'Ensure Ships.ShipAuthoring and Ships.Ship have correct dependencies',
                expectedCircularDependencies: [],
                expectedDependencies: {
                    'Ships.ShipAuthoring': ['Factions.FactionsEnum'],
                    'Ships.Ship': ['Factions.FactionsEnum']
                },
                testFunction: () => this.testShipsDependencies()
            },
            {
                name: 'Combat System Dependencies',
                description: 'Test various Combat systems and their dependencies',
                expectedCircularDependencies: [],
                expectedDependencies: {
                    'Combat.FindTargetAuthoring': ['Factions.FactionsEnum', 'Combat.FindTarget'],
                    'Combat.FindTarget': ['Factions.FactionsEnum']
                },
                testFunction: () => this.testCombatDependencies()
            },
            {
                name: 'No False Positive Circular Dependencies',
                description: 'Ensure we don\'t have false positive circular dependencies',
                expectedCircularDependencies: [
                    'Core.GameConstants → Combat.FindTargetSystem → Core.GameConstants'
                ],
                expectedDependencies: {},
                testFunction: () => this.testNoFalsePositives()
            }
        ];

        let allTestsPassed = true;
        let passedTests = 0;
        let totalTests = testCases.length;

        for (const testCase of testCases) {
            this.log(`\n📋 Running Test: ${testCase.name}`);
            this.log(`   Description: ${testCase.description}`);
            
            try {
                const result = await testCase.testFunction();
                if (result) {
                    this.log(`✅ PASSED: ${testCase.name}`);
                    passedTests++;
                } else {
                    this.log(`❌ FAILED: ${testCase.name}`);
                    allTestsPassed = false;
                }
            } catch (error) {
                this.log(`💥 ERROR in ${testCase.name}: ${error}`);
                allTestsPassed = false;
            }
        }

        this.log('\n📊 TEST SUMMARY');
        this.log('================');
        this.log(`Total Tests: ${totalTests}`);
        this.log(`Passed: ${passedTests}`);
        this.log(`Failed: ${totalTests - passedTests}`);
        this.log(`Success Rate: ${Math.round((passedTests / totalTests) * 100)}%`);
        
        if (allTestsPassed) {
            this.log('🎉 ALL TESTS PASSED! The dependency analysis is working correctly.');
        } else {
            this.log('🚨 SOME TESTS FAILED! Review the results above.');
        }

        return allTestsPassed;
    }

    private async testGameConstantsCircularDependency(): Promise<boolean> {
        this.log('🔍 Testing GameConstants ↔ FindTargetSystem circular dependency...');
        
        // Run class-level analysis
        const dependencies = await this.analyzer.analyzeClassDependencies(this.workspaceRoot);
        const circularDeps = this.circularDetector.findCircularDependencies(dependencies);
        
        this.log(`📦 Found ${dependencies.size} total dependencies`);
        this.log(`🔄 Found ${circularDeps.length} circular dependencies`);
        
        // Check if GameConstants exists and has FindTargetSystem dependency
        const gameConstants = dependencies.get('Core.GameConstants');
        if (!gameConstants) {
            this.log('❌ Core.GameConstants not found in dependencies');
            return false;
        }
        
        this.log(`🔍 GameConstants dependencies: [${gameConstants.dependencies.join(', ')}]`);
        
        if (!gameConstants.dependencies.includes('Combat.FindTargetSystem')) {
            this.log('❌ GameConstants should depend on Combat.FindTargetSystem');
            return false;
        }
        
        // Check if FindTargetSystem exists and has GameConstants dependency
        const findTargetSystem = dependencies.get('Combat.FindTargetSystem');
        if (!findTargetSystem) {
            this.log('❌ Combat.FindTargetSystem not found in dependencies');
            return false;
        }
        
        this.log(`🔍 FindTargetSystem dependencies: [${findTargetSystem.dependencies.join(', ')}]`);
        
        if (!findTargetSystem.dependencies.includes('Core.GameConstants')) {
            this.log('❌ FindTargetSystem should depend on Core.GameConstants');
            return false;
        }
        
        // Check if circular dependency is detected
        const hasCircularDep = circularDeps.some((circular: any) =>
            circular.cycle.includes('Core.GameConstants') && circular.cycle.includes('Combat.FindTargetSystem')
        );
        
        if (!hasCircularDep) {
            this.log('❌ Circular dependency between GameConstants and FindTargetSystem not detected');
            this.log(`🔍 Detected circular dependencies: ${JSON.stringify(circularDeps)}`);
            return false;
        }
        
        this.log('✅ GameConstants ↔ FindTargetSystem circular dependency correctly detected');
        return true;
    }

    private async testShipsDependencies(): Promise<boolean> {
        this.log('🔍 Testing Ships dependencies...');
        
        const dependencies = await this.analyzer.analyzeClassDependencies(this.workspaceRoot);
        
        // Check ShipAuthoring dependencies
        const shipAuthoring = dependencies.get('Ships.ShipAuthoring');
        if (!shipAuthoring) {
            this.log('❌ Ships.ShipAuthoring not found');
            return false;
        }
        
        if (!shipAuthoring.dependencies.includes('Factions.FactionsEnum')) {
            this.log('❌ ShipAuthoring should depend on FactionsEnum');
            this.log(`🔍 Actual dependencies: [${shipAuthoring.dependencies.join(', ')}]`);
            return false;
        }
        
        // Check Ship dependencies  
        const ship = dependencies.get('Ships.Ship');
        if (!ship) {
            this.log('❌ Ships.Ship not found');
            return false;
        }
        
        if (!ship.dependencies.includes('Factions.FactionsEnum')) {
            this.log('❌ Ship should depend on FactionsEnum');
            this.log(`🔍 Actual dependencies: [${ship.dependencies.join(', ')}]`);
            return false;
        }
        
        this.log('✅ Ships dependencies are correct');
        return true;
    }

    private async testCombatDependencies(): Promise<boolean> {
        this.log('🔍 Testing Combat system dependencies...');
        
        const dependencies = await this.analyzer.analyzeClassDependencies(this.workspaceRoot);
        
        // Check FindTargetAuthoring
        const findTargetAuthoring = dependencies.get('Combat.FindTargetAuthoring');
        if (!findTargetAuthoring) {
            this.log('❌ Combat.FindTargetAuthoring not found');
            return false;
        }
        
        if (!findTargetAuthoring.dependencies.includes('Factions.FactionsEnum')) {
            this.log('❌ FindTargetAuthoring should depend on FactionsEnum');
            this.log(`🔍 Actual dependencies: [${findTargetAuthoring.dependencies.join(', ')}]`);
            return false;
        }
        
        // Check FindTarget struct
        const findTarget = dependencies.get('Combat.FindTarget');
        if (!findTarget) {
            this.log('❌ Combat.FindTarget not found');
            return false;
        }
        
        if (!findTarget.dependencies.includes('Factions.FactionsEnum')) {
            this.log('❌ FindTarget should depend on FactionsEnum');
            this.log(`🔍 Actual dependencies: [${findTarget.dependencies.join(', ')}]`);
            return false;
        }
        
        this.log('✅ Combat dependencies are correct');
        return true;
    }

    private async testNoFalsePositives(): Promise<boolean> {
        this.log('🔍 Testing for false positive circular dependencies...');
        
        const dependencies = await this.analyzer.analyzeClassDependencies(this.workspaceRoot);
        const circularDeps = this.circularDetector.findCircularDependencies(dependencies);
        
        this.log(`🔄 Total circular dependencies found: ${circularDeps.length}`);
        
        // We should only have the legitimate GameConstants ↔ FindTargetSystem circular dependency
        const legitimateCircularDeps = circularDeps.filter((circular: any) =>
            circular.cycle.includes('Core.GameConstants') && circular.cycle.includes('Combat.FindTargetSystem')
        );
        
        const falsePositives = circularDeps.filter((circular: any) =>
            !(circular.cycle.includes('Core.GameConstants') && circular.cycle.includes('Combat.FindTargetSystem'))
        );
        
        if (falsePositives.length > 0) {
            this.log(`❌ Found ${falsePositives.length} false positive circular dependencies:`);
            falsePositives.forEach((circular: any, index: number) => {
                this.log(`   ${index + 1}. ${circular.cycle.join(' → ')}`);
            });
            return false;
        }
        
        if (legitimateCircularDeps.length !== 1) {
            this.log(`❌ Expected exactly 1 legitimate circular dependency, found ${legitimateCircularDeps.length}`);
            return false;
        }
        
        this.log('✅ No false positive circular dependencies detected');
        return true;
    }

    async runQuickValidation(): Promise<boolean> {
        this.log('⚡ Running Quick Validation...');
        
        const dependencies = await this.analyzer.analyzeClassDependencies(this.workspaceRoot);
        const circularDeps = this.circularDetector.findCircularDependencies(dependencies);
        
        this.log(`📦 Analyzed ${dependencies.size} classes`);
        this.log(`🔄 Found ${circularDeps.length} circular dependencies`);
        
        // Check the specific case
        const gameConstants = dependencies.get('Core.GameConstants');
        const findTargetSystem = dependencies.get('Combat.FindTargetSystem');
        
        if (!gameConstants || !findTargetSystem) {
            this.log('❌ Core classes not found');
            return false;
        }
        
        const hasCorrectDeps = 
            gameConstants.dependencies.includes('Combat.FindTargetSystem') &&
            findTargetSystem.dependencies.includes('Core.GameConstants');
            
        const hasCircularDep = circularDeps.some((circular: any) =>
            circular.cycle.includes('Core.GameConstants') && circular.cycle.includes('Combat.FindTargetSystem')
        );
        
        if (hasCorrectDeps && hasCircularDep) {
            this.log('✅ Quick validation PASSED!');
            return true;
        } else {
            this.log('❌ Quick validation FAILED!');
            this.log(`   GameConstants → FindTargetSystem: ${gameConstants.dependencies.includes('Combat.FindTargetSystem')}`);
            this.log(`   FindTargetSystem → GameConstants: ${findTargetSystem.dependencies.includes('Core.GameConstants')}`);
            this.log(`   Circular dependency detected: ${hasCircularDep}`);
            return false;
        }
    }
}