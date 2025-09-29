import os
import re
import webbrowser
import subprocess
import platform
from pathlib import Path
from collections import defaultdict, deque

def copy_to_clipboard(text):
    """Copy text to clipboard based on the operating system"""
    system = platform.system()
    
    if system == "Darwin":  # macOS
        process = subprocess.Popen(['pbcopy'], stdin=subprocess.PIPE)
        process.communicate(text.encode('utf-8'))
    elif system == "Windows":
        subprocess.run(['clip'], input=text, text=True, shell=True)
    elif system == "Linux":
        subprocess.run(['xclip', '-selection', 'clipboard'], input=text, text=True)
    else:
        print("Unsupported operating system for clipboard access")
        return False
    return True

def find_circular_dependencies(dependencies):
    """Find circular dependencies using DFS"""
    circular_deps = set()
    circular_nodes = set()
    visited = set()
    rec_stack = set()
    
    def dfs(node, path):
        if node in rec_stack:
            # Found a cycle - add all edges in the cycle
            try:
                cycle_start = path.index(node)
                cycle = path[cycle_start:] + [node]
                for i in range(len(cycle) - 1):
                    circular_deps.add((cycle[i], cycle[i + 1]))
                    circular_nodes.add(cycle[i])
                    circular_nodes.add(cycle[i + 1])
            except ValueError:
                # Node not in path, just add the direct edge
                if path:
                    circular_deps.add((path[-1], node))
                    circular_nodes.add(path[-1])
                    circular_nodes.add(node)
            return True
        
        if node in visited:
            return False
            
        visited.add(node)
        rec_stack.add(node)
        
        for neighbor in dependencies.get(node, []):
            if dfs(neighbor, path + [node]):
                return True
                
        rec_stack.remove(node)
        return False
    
    for node in dependencies:
        if node not in visited:
            dfs(node, [])
    
    # Only add edges that can actually reach back to themselves (true cycles)
    def is_edge_truly_circular(from_node, to_node):
        """Check if this specific edge is part of a circular path"""
        # Start from to_node and see if we can reach from_node
        visited_for_path = set()
        
        def can_reach_back(current, target):
            if current == target:
                return True
            if current in visited_for_path:
                return False
            visited_for_path.add(current)
            
            for neighbor in dependencies.get(current, []):
                if can_reach_back(neighbor, target):
                    return True
            return False
        
        return can_reach_back(to_node, from_node)
    
    # Only add edges that are truly circular
    truly_circular_deps = set()
    for from_node, to_node in circular_deps:
        if is_edge_truly_circular(from_node, to_node):
            truly_circular_deps.add((from_node, to_node))
    
    circular_deps = truly_circular_deps
    
    return circular_deps

def analyze_namespace_dependencies():
    """Analyze namespace-level dependencies with detailed information"""
    script_path = Path("Assets/Scripts")
    dependencies = {}
    dependency_details = {}  # namespace -> [(target_namespace, [file_paths])]
    
    print("Analyzing Unity namespace dependencies...")
    
    # First pass: collect all using statements with file locations
    namespace_usings = defaultdict(lambda: defaultdict(list))  # namespace -> target_namespace -> [file_paths]
    
    for cs_file in script_path.rglob("*.cs"):
        with open(cs_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract namespace
        namespace_match = re.search(r'^namespace\s+([\w.]+)', content, re.MULTILINE)
        if not namespace_match:
            continue
            
        namespace = namespace_match.group(1)
        
        # Extract using statements with line numbers
        lines = content.split('\n')
        for line_num, line in enumerate(lines, 1):
            using_match = re.match(r'^\s*using\s+([\w.]+);', line.strip())
            if using_match:
                target_namespace = using_match.group(1)
                if (not target_namespace.startswith(('System', 'Unity', 'UnityEngine'))
                    and target_namespace != namespace):
                    relative_path = str(cs_file.relative_to(Path("Assets/Scripts")))
                    namespace_usings[namespace][target_namespace].append(f"{relative_path}:{line_num}")
    
    # Build dependencies and details
    for namespace, targets in namespace_usings.items():
        if targets:
            dependencies[namespace] = list(targets.keys())
            dependency_details[namespace] = [(target, files) for target, files in targets.items()]
    
    return dependencies, dependency_details

def analyze_class_dependencies():
    """Analyze class-level dependencies with detailed information"""
    script_path = Path("Assets/Scripts")
    dependencies = {}
    dependency_details = {}  # class -> [(target_class, [reasons])]
    all_classes = {}  # class_name -> (namespace, full_name)
    
    print("Analyzing Unity class dependencies...")
    
    # First pass: collect all classes
    for cs_file in script_path.rglob("*.cs"):
        with open(cs_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract namespace
        namespace_match = re.search(r'^namespace\s+([\w.]+)', content, re.MULTILINE)
        namespace = namespace_match.group(1) if namespace_match else "Global"
        
        # Extract class names (more comprehensive patterns)
        class_patterns = [
            r'(?:public|internal|private)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)',
            r'(?:public|internal|private)?\s*(?:static\s+)?(?:partial\s+)?(?:sealed\s+)?class\s+(\w+)',
            r'(?:public|internal|private)?\s*struct\s+(\w+)',
            r'(?:public|internal|private)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?(?:sealed\s+)?class\s+(\w+)'
        ]
        
        # Simple approach: identify classes/structs that appear to be nested
        # by checking indentation and context
        lines = content.split('\n')
        nested_classes = set()
        
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped or stripped.startswith('//'):
                continue
                
            # Check for class/struct definitions
            for pattern in class_patterns:
                match = re.search(pattern, stripped)
                if match:
                    class_name = match.group(1)
                    
                    # Check if this appears to be nested by looking at preceding context
                    is_nested = False
                    
                    # Look backwards for an enclosing class/struct
                    for j in range(i-1, max(0, i-50), -1):  # Look back up to 50 lines
                        prev_line = lines[j].strip()
                        if not prev_line or prev_line.startswith('//'):
                            continue
                            
                        # If we find another class/struct declaration and there's no closing brace
                        # between current line and that declaration, we're nested
                        if re.search(r'\b(?:class|struct)\s+\w+', prev_line):
                            # Count braces between the previous class and current line
                            brace_balance = 0
                            for k in range(j, i):
                                line_to_check = lines[k]
                                brace_balance += line_to_check.count('{') - line_to_check.count('}')
                            
                            # If brace_balance > 0, we're still inside the previous class/struct
                            if brace_balance > 0:
                                is_nested = True
                                nested_classes.add(class_name)
                                break
                            else:
                                break  # We found a closed class, so we're not nested
                    
                    # Only add non-nested classes
                    if not is_nested:
                        full_class_name = f"{namespace}.{class_name}"
                        all_classes[class_name] = (namespace, full_class_name)
                    break
    
    # Second pass: find dependencies with detailed reasons
    for cs_file in script_path.rglob("*.cs"):
        with open(cs_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract namespace
        namespace_match = re.search(r'^namespace\s+([\w.]+)', content, re.MULTILINE)
        namespace = namespace_match.group(1) if namespace_match else "Global"
        
        # Extract using statements
        using_matches = re.findall(r'^using\s+([\w.]+);', content, re.MULTILINE)
        custom_usings = [u for u in using_matches
                        if not u.startswith(('System', 'Unity', 'UnityEngine'))]
        
        # Find all classes in this file
        current_file_classes = []
        for class_name, (class_namespace, full_name) in all_classes.items():
            if class_namespace == namespace:
                # Check if this class is actually defined in this file
                if re.search(rf'(?:class|struct)\s+{re.escape(class_name)}', content):
                    current_file_classes.append((class_name, full_name))
        
        # For each class in this file, find its dependencies with reasons
        for class_name, full_class_name in current_file_classes:
            class_deps = []
            class_dep_details = defaultdict(list)  # target_class -> [reasons]
            
            lines = content.split('\n')
            
            # Extract the specific scope/body of this class to avoid cross-contamination
            class_scope_lines = extract_class_scope(lines, class_name)
            
            # Look for references to other classes
            for other_class_name, (other_namespace, other_full_name) in all_classes.items():
                if other_full_name == full_class_name:
                    continue  # Skip self-reference
                
                # Skip other classes in the same file to avoid false positives from co-location
                other_short_name = other_class_name.split('.')[-1] if '.' in other_class_name else other_class_name
                if other_short_name in [c[0] for c in current_file_classes] and other_full_name != full_class_name:
                    # Check if this is a legitimate usage (not just co-location)
                    if not has_legitimate_class_usage(class_scope_lines, other_short_name):
                        continue
                
                # Check namespace availability
                if not (other_namespace == namespace or
                       other_namespace in custom_usings or
                       other_namespace == "Global"):
                    continue
                
                # Define patterns with their descriptions
                class_usage_patterns = [
                    (rf':\s*{re.escape(other_class_name)}', "inheritance"),
                    (rf':\s*.*,\s*{re.escape(other_class_name)}', "interface implementation"),
                    (rf'(?:public|private|protected|internal)\s+{re.escape(other_class_name)}\s+\w+', "field declaration"),
                    (rf'(?:public|private|protected|internal)\s+.*{re.escape(other_class_name)}\s+\w+', "field declaration"),
                    (rf'<{re.escape(other_class_name)}>', "generic type parameter"),
                    (rf'RefRW<{re.escape(other_class_name)}>', "ECS component reference (RefRW)"),
                    (rf'RefRO<{re.escape(other_class_name)}>', "ECS component reference (RefRO)"),
                    (rf'SystemAPI\..*<.*{re.escape(other_class_name)}.*>', "SystemAPI call"),
                    (rf'new\s+{re.escape(other_class_name)}\s*[\(\{{]', "object instantiation"),
                    (rf'{re.escape(other_class_name)}\.\w+', "static member access"),
                    (rf'GetComponent<{re.escape(other_class_name)}>', "GetComponent call"),
                    (rf'HasComponent<{re.escape(other_class_name)}>', "HasComponent call"),
                    (rf'AddComponent\([^,]*,\s*new\s+{re.escape(other_class_name)}(?!\w)\s*\(', "AddComponent call"),
                    (rf'typeof\({re.escape(other_class_name)}\)', "typeof reference"),
                    (rf'\[UpdateBefore\(typeof\({re.escape(other_class_name)}\)\)\]', "UpdateBefore dependency"),
                    (rf'\[UpdateAfter\(typeof\({re.escape(other_class_name)}\)\)\]', "UpdateAfter dependency"),
                    (rf'UpdateBefore.*{re.escape(other_class_name)}', "UpdateBefore dependency"),
                    (rf'UpdateAfter.*{re.escape(other_class_name)}', "UpdateAfter dependency"),
                    (rf'\b{re.escape(other_class_name)}\b.*\s+\w+\s*[\(;]', "method parameter/variable"),
                    (rf'\b{re.escape(other_class_name)}\b', "general reference"),
                ]
                
                found_references = False
                # Only search within the specific class scope, not the entire file
                for line_idx, line_content in class_scope_lines:
                    for pattern, description in class_usage_patterns:
                        if re.search(pattern, line_content):
                            relative_path = str(cs_file.relative_to(Path("Assets/Scripts")))
                            reason = f"{description} ({relative_path}:{line_idx})"
                            class_dep_details[other_full_name].append(reason)
                            found_references = True
                            break
                
                if found_references:
                    class_deps.append(other_full_name)
            
            if class_deps:
                dependencies[full_class_name] = list(set(class_deps))
                dependency_details[full_class_name] = [(target, list(set(reasons)))
                                                      for target, reasons in class_dep_details.items()]
    
    return dependencies, all_classes, dependency_details

def generate_dot_content(dependencies, circular_deps, diagram_type, dependency_details=None):
    """Generate DOT format content with color coding and descriptions"""
    dot_content = "digraph Dependencies {\n"
    dot_content += "  rankdir=TB;\n"
    dot_content += "  node [shape=box, style=filled];\n"
    dot_content += "  edge [fontsize=8];\n\n"
    
    # Find all nodes involved in circular dependencies
    circular_nodes = set()
    for from_node, to_node in circular_deps:
        circular_nodes.add(from_node)
        circular_nodes.add(to_node)
    
    # Add nodes with color coding
    all_nodes = set(dependencies.keys())
    for from_ns, to_list in dependencies.items():
        all_nodes.update(to_list)
    
    for node in all_nodes:
        color = "lightcoral" if node in circular_nodes else "lightgreen"
        # Escape node names that might contain special characters
        escaped_node = node.replace('"', '\\"')
        dot_content += f'  "{escaped_node}" [fillcolor={color}];\n'
    
    dot_content += "\n"
    
    # Add edges with color coding and labels
    for from_ns, to_list in dependencies.items():
        for to_ns in to_list:
            edge_color = "red" if (from_ns, to_ns) in circular_deps else "darkgreen"
            escaped_from = from_ns.replace('"', '\\"')
            escaped_to = to_ns.replace('"', '\\"')
            
            # Add dependency description as edge label ONLY for circular (red) dependencies
            label = ""
            if edge_color == "red" and dependency_details and from_ns in dependency_details:
                for target, reasons in dependency_details[from_ns]:
                    if target == to_ns:
                        # Truncate long reason lists for readability
                        if len(reasons) <= 2:
                            label = "\\n".join(reasons[:2])
                        else:
                            label = f"{reasons[0]}\\n...and {len(reasons)-1} more"
                        # Escape special characters in labels
                        label = label.replace('"', '\\"').replace('\n', '\\n')
                        break
            
            if label:
                dot_content += f'  "{escaped_from}" -> "{escaped_to}" [color={edge_color}, label="{label}"];\n'
            else:
                dot_content += f'  "{escaped_from}" -> "{escaped_to}" [color={edge_color}];\n'
    
    dot_content += "}"
    return dot_content

def analyze_systems_only():
    """Analyze only System classes (business logic) with detailed information"""
    script_path = Path("Assets/Scripts")
    dependencies = {}
    dependency_details = {}  # system -> [(target_system, [reasons])]
    all_systems = set()
    
    print("Analyzing Unity Systems dependencies...")
    
    # Find all System classes
    system_classes = {}
    
    for cs_file in script_path.rglob("*.cs"):
        with open(cs_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract namespace
        namespace_match = re.search(r'^namespace\s+([\w.]+)', content, re.MULTILINE)
        namespace = namespace_match.group(1) if namespace_match else "Global"
        
        # Find System classes (classes ending with "System" or implementing ISystem)
        system_patterns = [
            r'(?:public|internal|private)?\s*(?:partial\s+)?(?:struct|class)\s+(\w*System\w*)(?:\s*:|\s+implements|\s*{)',
            r'(?:public|internal|private)?\s*(?:partial\s+)?(?:struct|class)\s+(\w+)\s*:\s*.*ISystem',
            r'(?:public|internal|private)?\s*(?:partial\s+)?struct\s+(\w+)\s*:\s*.*ISystem'
        ]
        
        for pattern in system_patterns:
            matches = re.findall(pattern, content)
            for class_name in matches:
                if class_name and not class_name.endswith(('Authoring', 'Baker', 'Data')):
                    full_name = f"{namespace}.{class_name}"
                    system_classes[class_name] = (namespace, full_name)
                    all_systems.add(full_name)  # Track all systems
    
    # Find dependencies between systems with detailed reasons
    for cs_file in script_path.rglob("*.cs"):
        with open(cs_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract namespace
        namespace_match = re.search(r'^namespace\s+([\w.]+)', content, re.MULTILINE)
        namespace = namespace_match.group(1) if namespace_match else "Global"
        
        # Extract using statements
        using_matches = re.findall(r'^using\s+([\w.]+);', content, re.MULTILINE)
        custom_usings = [u for u in using_matches
                        if not u.startswith(('System', 'Unity', 'UnityEngine'))]
        
        # Check if this file contains any system classes
        current_systems = []
        for system_name, (sys_namespace, full_name) in system_classes.items():
            if sys_namespace == namespace and re.search(rf'(?:struct|class)\s+{re.escape(system_name)}', content):
                current_systems.append((system_name, full_name))
        
        # For each system in this file, find dependencies on other systems with reasons
        for system_name, full_system_name in current_systems:
            system_deps = []
            system_dep_details = defaultdict(list)
            
            lines = content.split('\n')
            
            for other_system_name, (other_namespace, other_full_name) in system_classes.items():
                if other_full_name == full_system_name:
                    continue
                
                # Check namespace availability
                if not (other_namespace == namespace or
                       other_namespace in custom_usings or
                       other_namespace == "Global"):
                    continue
                
                # Define patterns with descriptions for system dependencies
                system_usage_patterns = [
                    (rf'\[UpdateBefore\(typeof\({re.escape(other_system_name)}\)\)\]', "UpdateBefore dependency"),
                    (rf'\[UpdateAfter\(typeof\({re.escape(other_system_name)}\)\)\]', "UpdateAfter dependency"),
                    (rf'UpdateBefore.*{re.escape(other_system_name)}', "UpdateBefore dependency"),
                    (rf'UpdateAfter.*{re.escape(other_system_name)}', "UpdateAfter dependency"),
                    (rf'SystemAPI\.GetSingleton<{re.escape(other_system_name)}>', "SystemAPI singleton access"),
                    (rf'World\.GetOrCreateSystem<{re.escape(other_system_name)}>', "system reference"),
                    (rf'typeof\({re.escape(other_system_name)}\)', "typeof reference"),
                    (rf'\b{re.escape(other_system_name)}\b.*\s+\w+\s*[;=]', "variable/field reference"),
                    (rf'\b{re.escape(other_system_name)}\b', "general reference"),
                ]
                
                found_references = False
                for line_num, line in enumerate(lines, 1):
                    for pattern, description in system_usage_patterns:
                        if re.search(pattern, line):
                            relative_path = str(cs_file.relative_to(Path("Assets/Scripts")))
                            reason = f"{description} ({relative_path}:{line_num})"
                            system_dep_details[other_full_name].append(reason)
                            found_references = True
                            break
                
                if found_references:
                    system_deps.append(other_full_name)
            
            # Always add the system to dependencies, even if it has no deps
            dependencies[full_system_name] = list(set(system_deps)) if system_deps else []
            if system_deps:
                dependency_details[full_system_name] = [(target, list(set(reasons)))
                                                       for target, reasons in system_dep_details.items()]
    
    # Add any remaining systems that weren't processed (standalone systems)
    for system in all_systems:
        if system not in dependencies:
            dependencies[system] = []
    
    return dependencies, all_systems, dependency_details



def extract_class_scope(lines, class_name):
    """Extract the lines that belong to a specific class/struct scope"""
    class_scope_lines = []
    class_pattern = rf'(?:class|struct)\s+{re.escape(class_name)}(?:\s*:|<|\s+|\s*{{)'
    
    # Find the class definition line
    class_start_line = None
    for i, line in enumerate(lines):
        if re.search(class_pattern, line):
            class_start_line = i
            break
    
    if class_start_line is None:
        return class_scope_lines  # Class not found
    
    # Find the matching closing brace for this class
    brace_count = 0
    in_class = False
    
    for i in range(class_start_line, len(lines)):
        line = lines[i]
        
        # Start counting braces when we encounter the opening brace
        if '{' in line:
            brace_count += line.count('{')
            in_class = True
        
        if in_class:
            class_scope_lines.append((i + 1, line))  # Store with 1-based line number
        
        if '}' in line:
            brace_count -= line.count('}')
            
        # When brace count returns to 0, we've found the end of the class
        if in_class and brace_count <= 0:
            break
    
    return class_scope_lines

def has_legitimate_class_usage(class_scope_lines, other_class_name):
    """Check if there's a legitimate usage of another class within this class scope"""
    legitimate_patterns = [
        rf'new\s+{re.escape(other_class_name)}\s*[\(\{{]',  # object instantiation
        rf':\s*{re.escape(other_class_name)}',  # inheritance
        rf'<{re.escape(other_class_name)}>',  # generic parameter
        rf'AddComponent\([^,]*,\s*new\s+{re.escape(other_class_name)}',  # AddComponent
        rf'typeof\({re.escape(other_class_name)}\)',  # typeof reference
        rf'(?:public|private|protected|internal)\s+{re.escape(other_class_name)}\s+\w+',  # field declaration
        rf'{re.escape(other_class_name)}\.\w+',  # static member access
    ]
    
    for line_idx, line_content in class_scope_lines:
        for pattern in legitimate_patterns:
            if re.search(pattern, line_content.strip()):
                return True
    
    return False

def main():
    print("Unity Dependency Analyzer")
    print("=" * 40)
    print("Choose analysis type:")
    print("1. Namespace-level dependencies (default)")
    print("2. Class-level dependencies (all classes)")
    print("3. Systems-only dependencies (business logic)")
    
    choice = input("\nEnter your choice (1-3, default is 1): ").strip()
    
    dependency_details = None
    
    if choice == "2":
        dependencies, class_to_namespace, dependency_details = analyze_class_dependencies()
        diagram_type = "class"
        print(f"\n📊 Found {len(dependencies)} classes with dependencies:")
    elif choice == "3":
        dependencies, all_systems, dependency_details = analyze_systems_only()
        diagram_type = "systems"
        print(f"\n📊 Found {len(all_systems)} total systems ({len([k for k, v in dependencies.items() if v])} with dependencies):")
    else:
        dependencies, dependency_details = analyze_namespace_dependencies()
        diagram_type = "namespace"
        print(f"\n📊 Found {len(dependencies)} namespaces with dependencies:")
    
    if not dependencies:
        print("No dependencies found!")
        return
    
    # Find circular dependencies
    circular_deps = find_circular_dependencies(dependencies)
    
    if circular_deps:
        print(f"\n⚠️  Found {len(circular_deps)} circular dependencies:")
        for from_item, to_item in circular_deps:
            print(f"  🔴 {from_item} → {to_item}")
    else:
        print("\n✅ No circular dependencies found!")
    
    # Display all dependencies with detailed information
    print(f"\n📋 Detailed Dependencies ({diagram_type} level):")
    for item, deps in dependencies.items():
        status = "🔴" if any(item in edge for edge in circular_deps) else "🟢"
        print(f"\n  {status} {item}")
        
        if dependency_details and item in dependency_details:
            for target, reasons in dependency_details[item]:
                print(f"    → {target}")
                for reason in reasons[:3]:  # Show max 3 reasons for readability
                    print(f"      • {reason}")
                if len(reasons) > 3:
                    print(f"      • ...and {len(reasons)-3} more reasons")
        else:
            # Fallback to simple display if no details available
            for dep in deps:
                print(f"    → {dep}")
    
    # Show detailed analysis only for circular dependencies
    if dependency_details and circular_deps:
        print(f"\n🔍 Circular Dependency Analysis ({diagram_type} level):")
        print("=" * 60)
        
        # Get all nodes involved in circular dependencies
        circular_nodes = set()
        for from_node, to_node in circular_deps:
            circular_nodes.add(from_node)
            circular_nodes.add(to_node)
        
        # Show detailed reasons only for circular dependency edges
        for from_item, to_item in circular_deps:
            print(f"\n🔴 CIRCULAR: {from_item} → {to_item}")
            
            # Find and display the specific reasons for this circular edge
            if from_item in dependency_details:
                for target, reasons in dependency_details[from_item]:
                    if target == to_item:
                        print(f"  Dependency created by:")
                        for reason in reasons:
                            print(f"    • {reason}")
                        break
                else:
                    print(f"  (No detailed reason found - may be indirect dependency)")
    
    # Generate DOT format for Graphviz
    dot_content = generate_dot_content(dependencies, circular_deps, diagram_type, dependency_details)
    
    # Copy to clipboard
    if copy_to_clipboard(dot_content):
        print("\n✅ DOT format copied to clipboard!")
    else:
        print("\n❌ Failed to copy to clipboard. Here's the DOT content:")
        print(dot_content)
    
    # Open Graphviz Online
    print("🌐 Opening Graphviz Online...")
    webbrowser.open("https://dreampuf.github.io/GraphvizOnline/")
    
    print("\n📋 Instructions:")
    print("1. The DOT format is now in your clipboard")
    print("2. Graphviz Online should be opening in your browser")
    print("3. Press Cmd+V (or Ctrl+V) to paste and see your dependency graph!")
    print("\n🎨 Color Legend:")
    print("  🟢 Green nodes/edges: Normal dependencies")
    print("  🔴 Red nodes/edges: Circular dependencies")
    print("  📄 Edge labels: Show specific dependency reasons")

if __name__ == "__main__":
    main()
