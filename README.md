# C# Dependency Monitor

A powerful VS Code extension for real-time C# dependency analysis and circular dependency detection.

## Features

- **Real-time Analysis**: Monitor C# dependencies as you code with automatic file watching
- **Circular Dependency Detection**: Identify and visualize circular dependencies in your codebase
- **Interactive Visualization**: View dependency graphs with interactive node selection and highlighting
- **Multiple Analysis Levels**: Choose between namespace, class, or system-level analysis
- **Configurable Settings**: Customize analysis scope, ignored namespaces, and visualization options
- **Performance Optimized**: Efficient caching and incremental parsing for large codebases

## Commands

This extension provides the following commands:

- `C# Dependencies: Analyze Project` - Analyze the entire project for dependencies
- `C# Dependencies: Show Graph` - Display the interactive dependency visualization
- `C# Dependencies: Clear Cache` - Clear the analysis cache
- `C# Dependencies: Show Cache Statistics` - View cache performance statistics
- `C# Dependencies: Toggle Real-time Analysis` - Enable/disable real-time analysis

## Extension Settings

This extension contributes the following settings:

- `csharpDependencyMonitor.analysisLevel`: Level of dependency analysis (namespace/class/system)
- `csharpDependencyMonitor.enableRealTimeAnalysis`: Enable real-time analysis when files change
- `csharpDependencyMonitor.enableNotifications`: Show notifications for new circular dependencies
- `csharpDependencyMonitor.ignoredNamespaces`: Namespaces to ignore during analysis
- `csharpDependencyMonitor.projectPaths`: Paths to search for C# files
- `csharpDependencyMonitor.visualization.*`: Various visualization customization options

## Requirements

- VS Code 1.104.0 or later
- C# project with .cs files

## Installation

1. Install the extension from the VS Code marketplace
2. Open a workspace containing C# files
3. Use the command palette to run dependency analysis commands

## Usage

1. Open a C# project in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) to open the command palette
3. Type "C# Dependencies" to see available commands
4. Run "C# Dependencies: Analyze Project" to start analysis
5. Use "C# Dependencies: Show Graph" to view the interactive visualization

## Release Notes

### 0.0.1

Initial release of C# Dependency Monitor with:

- Real-time dependency analysis
- Circular dependency detection
- Interactive visualization
- Configurable analysis settings
- Performance optimizations

---

**Enjoy analyzing your C# dependencies!**
