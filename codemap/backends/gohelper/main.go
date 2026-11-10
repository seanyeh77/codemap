// Command codemap-gohelper reads the Go packages of a repository with go/types and writes the
// codemap graph (codemap/schema.py) as JSON on standard output.
//
// It uses the standard library only, so it builds offline. Packages are found by directory and
// go.mod, not by `go list`, which would need the module's toolchain and dependencies: a package
// outside the repository that cannot be read from GOROOT or the module cache becomes an empty
// stand-in, and calls into it are still named by their import path.
//
// Input (stdin): {"root": "...", "files": ["cmd/x/main.go", ...]}
// Output: {"nodes": {...}, "edges": [...], "stats": {...}}
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

type Node struct {
	Name    string   `json:"name"`
	File    string   `json:"file"`
	Line    int      `json:"line,omitempty"`
	End     int      `json:"end,omitempty"`
	Defined bool     `json:"defined"`
	Lang    string   `json:"lang,omitempty"`
	Kind    string   `json:"kind,omitempty"`
	Params  []string `json:"params,omitempty"`
	Class   string   `json:"class,omitempty"`
	Bases   []string `json:"bases,omitempty"`
	// the package did not type-check fully: calls inside may be missing
	TypesIncomplete bool `json:"types_incomplete,omitempty"`
	// an outside package that could not be read: the node is known by name only
	Placeholder bool `json:"placeholder,omitempty"`
}

type Infer struct {
	How     string `json:"how"`
	Type    string `json:"type,omitempty"`
	Partial bool   `json:"partial,omitempty"`
}

type Edge struct {
	Src        string `json:"src"`
	Dst        string `json:"dst"`
	File       string `json:"file"`
	Line       int    `json:"line"`
	Col        int    `json:"col"`
	Kind       string `json:"kind"`
	Source     string `json:"source"`
	Resolution string `json:"resolution"`
	Mode       string `json:"mode,omitempty"`
	Infer      *Infer `json:"infer,omitempty"`
}

type Pkg struct {
	Path, Dir, Name string
	Files           []*ast.File
	Rel             []string
	Types           *types.Package
	Info            *types.Info
	checking, done  bool
}

type Analyzer struct {
	root, module string
	tests        map[string]bool // absolute paths of test files, or nil for the _test.go convention
	fset         *token.FileSet
	pkgs         map[string]*Pkg // import path (x_test: path + "_test")
	std          types.Importer
	fake         map[string]*types.Package
	nodes        map[string]*Node
	edges        []Edge
	ids          map[types.Object]string
	named        []*types.TypeName       // the repository's named types, for interface dispatch
	assigns      map[*types.Var][]ast.Expr // values given to variables and struct fields
	unresolved   map[string]int
	builtin      int
	errors       []string
	counts       map[string]int
	lits         map[*ast.FuncLit]string // closures: their node ids
	placeholders map[string]bool         // import paths read as empty stand-ins
	broken       map[string]int          // file -> type errors in it
	ifaceUsed    map[*types.Func]*types.Interface // outside interface methods called somewhere
	ifaceRecv    map[*types.Func]types.Type
	where        map[ast.Expr]*Pkg       // the package an assigned value belongs to
}

func main() {
	var in struct {
		Root  string   `json:"root"`
		Files []string `json:"files"`
		Tests []string `json:"tests"` // the test files, after .codemap/rules.json; missing: the _test.go convention
	}
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "codemap-gohelper:", err)
		os.Exit(2)
	}
	a := &Analyzer{root: in.Root, fset: token.NewFileSet(), pkgs: map[string]*Pkg{}, fake: map[string]*types.Package{},
		nodes: map[string]*Node{}, ids: map[types.Object]string{}, assigns: map[*types.Var][]ast.Expr{},
		unresolved: map[string]int{}, counts: map[string]int{}, lits: map[*ast.FuncLit]string{}, where: map[ast.Expr]*Pkg{},
		placeholders: map[string]bool{}, broken: map[string]int{}, ifaceUsed: map[*types.Func]*types.Interface{}, ifaceRecv: map[*types.Func]types.Type{}}
	if in.Tests != nil {
		a.tests = map[string]bool{}
		for _, f := range in.Tests {
			a.tests[filepath.Join(in.Root, f)] = true
		}
	}
	a.std = importer.ForCompiler(a.fset, "source", nil)
	a.module = readModule(in.Root)
	a.load(in.Files)
	keys := make([]string, 0, len(a.pkgs))
	for k := range a.pkgs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		a.check(a.pkgs[k])
	}
	for _, k := range keys {
		a.define(a.pkgs[k])
	}
	for _, k := range keys {
		a.collectAssigns(a.pkgs[k])
	}
	for _, k := range keys {
		a.calls(a.pkgs[k])
	}
	a.implements()
	top := [][2]any{}
	for k, v := range a.unresolved {
		top = append(top, [2]any{k, v})
	}
	sort.Slice(top, func(i, j int) bool { return top[i][1].(int) > top[j][1].(int) })
	if len(top) > 20 {
		top = top[:20]
	}
	total := 0
	for _, v := range a.unresolved {
		total += v
	}
	a.counts["unresolved"] = total
	a.counts["builtin"] = a.builtin
	defs := 0
	for _, n := range a.nodes {
		if n.Defined {
			defs++
		}
	}
	files := 0
	for _, p := range a.pkgs {
		files += len(p.Files)
	}
	out := map[string]any{"nodes": a.nodes, "edges": a.edges, "stats": map[string]any{
		"files": files, "languages": map[string]int{"go": files}, "nodes": defs, "edges": len(a.edges),
		"packages": len(a.pkgs), "resolution": a.counts, "unresolved_top": top, "errors": a.errors,
		"placeholders": sortedKeys(a.placeholders), "incomplete_files": len(a.broken)}}
	if a.edges == nil {
		out["edges"] = []Edge{}
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "codemap-gohelper:", err)
		os.Exit(2)
	}
}

func sortedKeys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func readModule(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return ""
	}
	for _, ln := range strings.Split(string(b), "\n") {
		if f := strings.Fields(ln); len(f) >= 2 && f[0] == "module" {
			return strings.Trim(f[1], "\"")
		}
	}
	return ""
}

// ---------------------------------------------------------------- packages

// importPath: the import path of a directory, from the nearest go.mod at or above it (a repository
// may hold several modules: svc/go.mod, tools/go.mod), else the directory itself.
func (a *Analyzer) importPath(dir string) string {
	d := filepath.ToSlash(dir)
	if d == "." {
		d = ""
	}
	for up := d; ; {
		if mod := readModule(filepath.Join(a.root, up)); mod != "" {
			rest := strings.TrimPrefix(strings.TrimPrefix(d, up), "/")
			if rest == "" {
				return mod
			}
			return mod + "/" + rest
		}
		if up == "" {
			return d
		}
		if i := strings.LastIndex(up, "/"); i >= 0 {
			up = up[:i]
		} else {
			up = ""
		}
	}
}

func (a *Analyzer) load(files []string) {
	for _, rel := range files {
		f, err := parser.ParseFile(a.fset, filepath.Join(a.root, rel), nil, parser.SkipObjectResolution)
		if err != nil {
			a.errors = append(a.errors, fmt.Sprintf("%s: %v", rel, err))
			if f == nil {
				continue
			}
		}
		dir := filepath.Dir(rel)
		p := a.importPath(dir)
		name := f.Name.Name
		if strings.HasSuffix(name, "_test") && strings.HasSuffix(rel, "_test.go") {
			p += "_test" // the external test package of a directory
		}
		pk := a.pkgs[p]
		if pk == nil {
			pk = &Pkg{Path: p, Dir: dir, Name: name}
			a.pkgs[p] = pk
		}
		pk.Files = append(pk.Files, f)
		pk.Rel = append(pk.Rel, filepath.ToSlash(rel))
	}
}

// Import gives the type checker a package: the repository's own, the standard library from
// GOROOT, a module from the module cache, or an empty stand-in.
func (a *Analyzer) Import(p string) (*types.Package, error) {
	if pk, ok := a.pkgs[p]; ok {
		a.check(pk)
		if pk.Types != nil {
			return pk.Types, nil
		}
	}
	if t, ok := a.fake[p]; ok {
		return t, nil
	}
	if !strings.Contains(strings.Split(p, "/")[0], ".") {
		if t, err := a.std.Import(p); err == nil {
			a.fake[p] = t
			return t, nil
		}
	} else if t := a.fromModCache(p); t != nil {
		a.fake[p] = t
		return t, nil
	}
	t := types.NewPackage(p, path.Base(p))
	t.MarkComplete()
	a.fake[p] = t
	a.placeholders[p] = true
	return t, nil
}

func (a *Analyzer) fromModCache(p string) *types.Package {
	// a module already in the module cache is read from source; nothing is downloaded
	ctx := build.Default
	bp, err := ctx.Import(p, a.root, build.FindOnly)
	if err != nil || bp.Dir == "" {
		return nil
	}
	t, err := a.std.(types.ImporterFrom).ImportFrom(p, a.root, 0)
	if err != nil {
		return nil
	}
	return t
}

func (a *Analyzer) check(pk *Pkg) {
	if pk.done || pk.checking {
		return
	}
	pk.checking = true
	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Defs: map[*ast.Ident]types.Object{},
		Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{},
		Implicits: map[ast.Node]types.Object{}}
	errs := 0
	conf := types.Config{Importer: a, Error: func(err error) {
		errs++
		if te, ok := err.(types.Error); ok { // the file it is in: an error in a test file says nothing of the others
			f, _ := a.rel(te.Pos)
			a.broken[f]++
		}
		if errs <= 3 {
			a.errors = append(a.errors, err.Error())
		}
	}, FakeImportC: true}
	t, _ := conf.Check(pk.Path, a.fset, pk.Files, info)
	pk.Types, pk.Info = t, info
	pk.checking, pk.done = false, true
}

// ---------------------------------------------------------------- definitions

func (a *Analyzer) rel(pos token.Pos) (string, int) {
	p := a.fset.Position(pos)
	r, err := filepath.Rel(a.root, p.Filename)
	if err != nil {
		r = p.Filename
	}
	return filepath.ToSlash(r), p.Line
}

func recvName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return ""
	}
	t := fd.Recv.List[0].Type
	for {
		switch x := t.(type) {
		case *ast.StarExpr:
			t = x.X
		case *ast.IndexExpr:
			t = x.X
		case *ast.IndexListExpr:
			t = x.X
		case *ast.ParenExpr:
			t = x.X
		case *ast.Ident:
			return x.Name
		default:
			return ""
		}
	}
}

func (a *Analyzer) define(pk *Pkg) {
	for _, f := range pk.Files {
		file, _ := a.rel(f.Pos())
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				name := d.Name.Name
				r := recvName(d)
				kind := "function"
				if r != "" {
					name, kind = r+"."+name, "method"
				}
				id := file + ":" + name
				_, line := a.rel(d.Pos())
				_, end := a.rel(d.End())
				// a function is named as its callers write it, store.New, so that New of every package is told apart
				shown := name
				if r == "" && pk.Name != "main" {
					shown = pk.Name + "." + name
				}
				n := &Node{Name: shown, File: file, Line: line, End: end, Defined: true, Lang: "go", Kind: kind, TypesIncomplete: a.broken[file] > 0}
				for _, fl := range d.Type.Params.List {
					for _, nm := range fl.Names {
						n.Params = append(n.Params, nm.Name)
					}
				}
				if r != "" {
					n.Class = a.typeID(pk, r)
				}
				a.nodes[id] = n
				if obj := pk.Info.Defs[d.Name]; obj != nil {
					a.ids[obj] = id
				}
				// func literals inside: closures, named after their function as Go does (Serve.func1)
				k := 0
				ast.Inspect(d, func(x ast.Node) bool {
					if fl, ok := x.(*ast.FuncLit); ok {
						k++
						cid := fmt.Sprintf("%s.func%d", id, k)
						_, l := a.rel(fl.Pos())
						_, e := a.rel(fl.End())
						a.nodes[cid] = &Node{Name: fmt.Sprintf("%s.func%d", shown, k), File: file, Line: l, End: e, Defined: true, Lang: "go", Kind: "function"}
						a.lits[fl] = cid
					}
					return true
				})
			case *ast.GenDecl:
				for _, s := range d.Specs {
					ts, ok := s.(*ast.TypeSpec)
					if !ok {
						continue
					}
					id := file + ":" + ts.Name.Name
					_, line := a.rel(ts.Pos())
					_, end := a.rel(ts.End())
					n := &Node{Name: ts.Name.Name, File: file, Line: line, End: end, Defined: true, Lang: "go", Kind: "class"}
					if st, ok := ts.Type.(*ast.StructType); ok {
						for _, fl := range st.Fields.List {
							if len(fl.Names) == 0 { // an embedded type
								n.Bases = append(n.Bases, exprString(fl.Type))
							}
						}
					}
					a.nodes[id] = n
					if obj, ok := pk.Info.Defs[ts.Name].(*types.TypeName); ok {
						a.ids[obj] = id
						a.named = append(a.named, obj)
					}
				}
			}
		}
	}
}

func (a *Analyzer) typeID(pk *Pkg, name string) string {
	if pk.Types == nil {
		return ""
	}
	if obj := pk.Types.Scope().Lookup(name); obj != nil {
		f, _ := a.rel(obj.Pos())
		return f + ":" + name
	}
	return ""
}

func exprString(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.StarExpr:
		return "*" + exprString(x.X)
	case *ast.SelectorExpr:
		return exprString(x.X) + "." + x.Sel.Name
	case *ast.IndexExpr:
		return exprString(x.X)
	}
	return ""
}

// ---------------------------------------------------------------- values (2B)

// collectAssigns records every value given to a variable or a struct field: x := &Server{},
// var h Handler = mem{}, s.handler = process, Server{store: db}. Dispatch through interfaces and
// calls through function values read them.
func (a *Analyzer) collectAssigns(pk *Pkg) {
	add := func(lhs ast.Expr, rhs ast.Expr) {
		var obj types.Object
		switch l := unparen(lhs).(type) {
		case *ast.Ident:
			obj = pk.Info.Defs[l]
			if obj == nil {
				obj = pk.Info.Uses[l]
			}
		case *ast.SelectorExpr:
			if sel := pk.Info.Selections[l]; sel != nil && sel.Kind() == types.FieldVal {
				obj = sel.Obj()
			}
		}
		if v, ok := obj.(*types.Var); ok && rhs != nil {
			a.assigns[v] = append(a.assigns[v], rhs)
			a.where[rhs] = pk
		}
	}
	for _, f := range pk.Files {
		ast.Inspect(f, func(x ast.Node) bool {
			switch s := x.(type) {
			case *ast.AssignStmt:
				if len(s.Lhs) == len(s.Rhs) {
					for i := range s.Lhs {
						add(s.Lhs[i], s.Rhs[i])
					}
				}
			case *ast.ValueSpec:
				if len(s.Names) == len(s.Values) {
					for i := range s.Names {
						add(s.Names[i], s.Values[i])
					}
				}
			case *ast.CompositeLit: // Server{store: db, handle: process}
				if t := pk.Info.Types[s].Type; t != nil {
					if st, ok := t.Underlying().(*types.Struct); ok {
						for _, el := range s.Elts {
							if kv, ok := el.(*ast.KeyValueExpr); ok {
								if k, ok := kv.Key.(*ast.Ident); ok {
									for i := 0; i < st.NumFields(); i++ {
										if st.Field(i).Name() == k.Name {
											a.assigns[st.Field(i)] = append(a.assigns[st.Field(i)], kv.Value)
											a.where[kv.Value] = pk
										}
									}
								}
							}
						}
					}
				}
			}
			return true
		})
	}
}

func unparen(e ast.Expr) ast.Expr {
	for {
		p, ok := e.(*ast.ParenExpr)
		if !ok {
			return e
		}
		e = p.X
	}
}

// concrete: the non-interface types a variable or field holds, from the values given to it, and
// how they were found; ok is false when some value's type is unknown or an interface.
func (a *Analyzer) concrete(v *types.Var, seen map[*types.Var]bool, prod bool) (ts []types.Type, how string, ok bool) {
	if seen[v] {
		return nil, "", false
	}
	seen[v] = true
	vals := a.assigns[v]
	if len(vals) == 0 {
		return nil, "", false
	}
	how = "assign"
	n := 0
	for _, e := range vals {
		// production code does not run what a test stores: a test's fake is not a production value
		if prod && a.isTest(e.Pos()) {
			continue
		}
		n++
		pk := a.where[e]
		if pk == nil {
			return nil, "", false
		}
		e = unparen(e)
		if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
			if _, ok := u.X.(*ast.CompositeLit); ok {
				how = "constructor" // &Server{}
			}
		}
		if _, ok := e.(*ast.CompositeLit); ok {
			how = "constructor"
		}
		t := pk.Info.Types[e].Type
		if t == nil {
			return nil, "", false
		}
		if types.IsInterface(t) {
			// the value is itself an interface: follow it one step if it is a plain variable
			if id, ok := e.(*ast.Ident); ok {
				if w, ok := pk.Info.Uses[id].(*types.Var); ok {
					more, _, ok2 := a.concrete(w, seen, prod)
					if !ok2 {
						return nil, "", false
					}
					ts = append(ts, more...)
					continue
				}
			}
			if call, ok := e.(*ast.CallExpr); ok {
				if fn := a.calledFunc(pk, call); fn != nil {
					if rt := a.returnsConcrete(fn); len(rt) > 0 {
						ts, how = append(ts, rt...), "return"
						continue
					}
				}
			}
			return nil, "", false
		}
		ts = append(ts, t)
	}
	if n == 0 {
		return nil, "", false
	}
	return ts, how, true
}

// isTest: the position is in a test file (_test.go, or as .codemap/rules.json says).
func (a *Analyzer) isTest(pos token.Pos) bool {
	name := a.fset.Position(pos).Filename
	if a.tests != nil {
		return a.tests[name]
	}
	return strings.HasSuffix(name, "_test.go")
}

func (a *Analyzer) calledFunc(pk *Pkg, call *ast.CallExpr) *types.Func {
	switch f := unparen(call.Fun).(type) {
	case *ast.Ident:
		fn, _ := pk.Info.Uses[f].(*types.Func)
		return fn
	case *ast.SelectorExpr:
		fn, _ := pk.Info.Uses[f.Sel].(*types.Func)
		return fn
	}
	return nil
}

// returnsConcrete: for a function whose result is an interface, the concrete types its return
// statements give (func New() Store { return &mem{} } gives *mem).
func (a *Analyzer) returnsConcrete(fn *types.Func) []types.Type {
	decl, pk := a.declOf(fn)
	if decl == nil || decl.Body == nil {
		return nil
	}
	var out []types.Type
	bad := false
	ast.Inspect(decl.Body, func(x ast.Node) bool {
		if _, ok := x.(*ast.FuncLit); ok {
			return false
		}
		if r, ok := x.(*ast.ReturnStmt); ok && len(r.Results) > 0 {
			t := pk.Info.Types[r.Results[0]].Type
			if t == nil || types.IsInterface(t) {
				if id, ok := r.Results[0].(*ast.Ident); !ok || id.Name != "nil" {
					bad = true
				}
				return true
			}
			out = append(out, t)
		}
		return true
	})
	if bad {
		return nil
	}
	return out
}

func (a *Analyzer) declOf(fn *types.Func) (*ast.FuncDecl, *Pkg) {
	if fn.Pkg() == nil {
		return nil, nil
	}
	pk := a.pkgs[fn.Pkg().Path()]
	if pk == nil {
		return nil, nil
	}
	for _, f := range pk.Files {
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && pk.Info.Defs[fd.Name] == fn {
				return fd, pk
			}
		}
	}
	return nil, nil
}

// ---------------------------------------------------------------- calls (2C)

func (a *Analyzer) id(obj types.Object) string {
	if id, ok := a.ids[obj]; ok {
		return id
	}
	// outside the repository: named by import path, and by receiver type for a method
	name := obj.Name()
	if fn, ok := obj.(*types.Func); ok {
		if sig, ok := fn.Type().(*types.Signature); ok && sig.Recv() != nil {
			rt := sig.Recv().Type()
			if p, ok := rt.(*types.Pointer); ok {
				rt = p.Elem()
			}
			if n, ok := rt.(*types.Named); ok {
				name = n.Obj().Name() + "." + name
			}
		}
	}
	p := ""
	if obj.Pkg() != nil {
		p = obj.Pkg().Path() + "."
	}
	ext := "ext:" + p + name
	if _, ok := a.nodes[ext]; !ok {
		a.nodes[ext] = &Node{Name: p + name, File: "", Defined: false, Placeholder: obj.Pkg() != nil && a.placeholders[obj.Pkg().Path()]}
	}
	return ext
}

func typeName(t types.Type) string {
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	if n, ok := t.(*types.Named); ok {
		return n.Obj().Name()
	}
	return t.String()
}

// methodOf: the method a concrete type's method set has for a name (promoted ones included).
func methodOf(t types.Type, name string) (*types.Func, bool) {
	for _, tt := range []types.Type{t, types.NewPointer(t)} {
		if p, ok := t.(*types.Pointer); ok && tt != t {
			_ = p
			continue
		}
		ms := types.NewMethodSet(tt)
		for i := 0; i < ms.Len(); i++ {
			s := ms.At(i)
			if s.Obj().Name() == name {
				fn, _ := s.Obj().(*types.Func)
				return fn, len(s.Index()) > 1
			}
		}
	}
	return nil, false
}

type target struct {
	id      string
	how     string
	typ     string
	partial bool
}

func (a *Analyzer) emit(owner string, pos token.Pos, kind, mode string, ts []target, res string) {
	file, line := a.rel(pos)
	col := a.fset.Position(pos).Column
	seen, uniq := map[string]bool{}, ts[:0:0]
	for _, t := range ts {
		if !seen[t.id] {
			seen[t.id] = true
			uniq = append(uniq, t)
		}
	}
	ts = uniq
	// several targets, or targets that are only some of them: none is the one
	if res != "exact" && (len(ts) > 1 || len(ts) == 1 && ts[0].partial) {
		res = "ambiguous"
	}
	for _, t := range ts {
		r := res
		e := Edge{Src: owner, Dst: t.id, File: file, Line: line, Col: col, Kind: kind, Source: "static", Resolution: r, Mode: mode}
		if t.how != "" {
			e.Infer = &Infer{How: t.how, Type: t.typ, Partial: t.partial}
		}
		a.edges = append(a.edges, e)
		a.counts[r]++
	}
}

func (a *Analyzer) calls(pk *Pkg) {
	if pk.Info == nil {
		return
	}
	for _, f := range pk.Files {
		file, _ := a.rel(f.Pos())
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			name := fd.Name.Name
			if r := recvName(fd); r != "" {
				name = r + "." + name
			}
			a.walk(pk, fd.Body, file+":"+name)
		}
		// package-level var x = f(): code that runs when the package initializes
		for _, d := range f.Decls {
			if gd, ok := d.(*ast.GenDecl); ok && gd.Tok == token.VAR {
				init := file + ":<init>"
				before := len(a.edges)
				a.walk(pk, gd, init)
				if len(a.edges) > before {
					a.nodes[init] = &Node{Name: filepath.Base(file) + " (package init)", File: file, Line: 1, End: 1, Defined: true, Lang: "go", Kind: "module"}
				}
			}
		}
	}
}

// walk visits a body: calls, go and defer, functions used as values; a func literal is an owner of
// its own.
func (a *Analyzer) walk(pk *Pkg, body ast.Node, owner string) {
	mode := map[*ast.CallExpr]string{}
	called := map[ast.Expr]bool{}
	ast.Inspect(body, func(x ast.Node) bool {
		switch s := x.(type) {
		case *ast.GoStmt:
			mode[s.Call] = "go"
		case *ast.DeferStmt:
			mode[s.Call] = "defer"
		case *ast.CallExpr:
			called[unparen(s.Fun)] = true
		}
		return true
	})
	var visit func(n ast.Node, owner string)
	visit = func(n ast.Node, owner string) {
		ast.Inspect(n, func(x ast.Node) bool {
			switch e := x.(type) {
			case *ast.FuncLit:
				if e == n {
					return true
				}
				if cid, ok := a.lits[e]; ok {
					visit(e.Body, cid)
				}
				return false
			case *ast.CallExpr:
				a.call(pk, e, owner, mode[e])
			case *ast.SelectorExpr:
				// x.Name is one name: its Sel is not a value of its own; x may still hold calls
				if !called[e] {
					a.funcValue(pk, e, owner)
				}
				visit(e.X, owner)
				return false
			case *ast.Ident:
				if !called[e] {
					a.funcValue(pk, e, owner)
				}
			}
			return true
		})
	}
	visit(body, owner)
}

// funcValue: a function or method named but not called here, handed somewhere to be called
// later: m.HandleFunc("/x", s.page), handler := process, sort.Slice(x, less).
func (a *Analyzer) funcValue(pk *Pkg, e ast.Expr, owner string) {
	var fn *types.Func
	how, typ := "funcvalue", ""
	switch x := e.(type) {
	case *ast.Ident:
		fn, _ = pk.Info.Uses[x].(*types.Func)
	case *ast.SelectorExpr:
		if sel := pk.Info.Selections[x]; sel != nil {
			if sel.Kind() == types.MethodVal || sel.Kind() == types.MethodExpr {
				fn, _ = sel.Obj().(*types.Func)
				if sel.Kind() == types.MethodExpr {
					how = "methodexpr"
				} else {
					how = "methodvalue"
				}
				if types.IsInterface(sel.Recv()) {
					return
				}
				typ = typeName(sel.Recv())
			}
		} else {
			fn, _ = pk.Info.Uses[x.Sel].(*types.Func)
		}
	}
	if fn == nil {
		return
	}
	if _, ok := a.ids[fn]; !ok {
		return // a function of another module handed around: not worth a line
	}
	a.emit(owner, e.Pos(), "ref", "", []target{{id: a.id(fn), how: how, typ: typ}}, "exact")
}

func (a *Analyzer) call(pk *Pkg, call *ast.CallExpr, owner, mode string) {
	fun := unparen(call.Fun)
	if ix, ok := fun.(*ast.IndexExpr); ok { // F[int](...)
		fun = ix.X
	}
	if ix, ok := fun.(*ast.IndexListExpr); ok {
		fun = ix.X
	}
	label := exprString(fun)
	switch f := fun.(type) {
	case *ast.FuncLit: // func() { ... }(): runs right here
		if cid, ok := a.lits[f]; ok {
			a.emit(owner, call.Pos(), "call", mode, []target{{id: cid}}, "exact")
		}
		return
	case *ast.Ident:
		switch obj := pk.Info.Uses[f].(type) {
		case *types.Func:
			a.emit(owner, call.Pos(), "call", mode, []target{{id: a.id(obj)}}, "exact")
			return
		case *types.Builtin, *types.TypeName:
			a.builtin++
			return
		case *types.Var: // handler(): a function value
			if ts := a.funcValues(obj, !a.isTest(call.Pos())); len(ts) > 0 {
				a.emit(owner, call.Pos(), "call", mode, ts, "inferred")
				return
			}
		}
	case *ast.SelectorExpr:
		sel := pk.Info.Selections[f]
		if sel == nil { // pkg.Func
			if fn, ok := pk.Info.Uses[f.Sel].(*types.Func); ok {
				a.emit(owner, call.Pos(), "call", mode, []target{{id: a.id(fn)}}, "exact")
				return
			}
			if _, ok := pk.Info.Uses[f.Sel].(*types.TypeName); ok {
				a.builtin++ // a conversion: pkg.Type(x)
				return
			}
			if x, ok := f.X.(*ast.Ident); ok {
				if pn, ok := pk.Info.Uses[x].(*types.PkgName); ok { // a package we could not read
					ext := "ext:" + pn.Imported().Path() + "." + f.Sel.Name
					if _, ok := a.nodes[ext]; !ok {
						a.nodes[ext] = &Node{Name: ext[4:], Defined: false, Placeholder: a.placeholders[pn.Imported().Path()]}
					}
					a.emit(owner, call.Pos(), "call", mode, []target{{id: ext}}, "exact")
					return
				}
			}
			break
		}
		switch sel.Kind() {
		case types.MethodExpr: // (*Server).Serve(s)
			a.emit(owner, call.Pos(), "call", mode, []target{{id: a.id(sel.Obj()), how: "methodexpr", typ: typeName(sel.Recv())}}, "exact")
			return
		case types.FieldVal: // s.handle(): a function in a field
			if v, ok := sel.Obj().(*types.Var); ok {
				if ts := a.funcValues(v, !a.isTest(call.Pos())); len(ts) > 0 {
					for i := range ts {
						ts[i].how = "field"
					}
					a.emit(owner, call.Pos(), "call", mode, ts, "inferred")
					return
				}
			}
		case types.MethodVal:
			recv := sel.Recv()
			fn, _ := sel.Obj().(*types.Func)
			if !types.IsInterface(recv) {
				// a concrete receiver: Go dispatches statically, promoted methods included
				t := target{id: a.id(fn)}
				if len(sel.Index()) > 1 {
					t.how, t.typ = "embedding", typeName(recv)
				}
				a.emit(owner, call.Pos(), "call", mode, []target{t}, "exact")
				return
			}
			a.dispatch(pk, call, f, recv, fn, owner, mode)
			return
		}
	}
	if t := pk.Info.Types[fun].Type; t != nil {
		if _, ok := t.Underlying().(*types.Signature); !ok {
			a.builtin++ // a conversion
			return
		}
	}
	a.unresolved[label]++
}

// funcValues: the functions a variable or field of function type holds, from the values given to it.
func (a *Analyzer) funcValues(v *types.Var, prod bool) []target {
	var out []target
	partial := false
	for _, e := range a.assigns[v] {
		if prod && a.isTest(e.Pos()) {
			continue // a test's stand-in, not what production code calls
		}
		pk := a.where[e]
		e = unparen(e)
		switch x := e.(type) {
		case *ast.FuncLit:
			if cid, ok := a.lits[x]; ok {
				out = append(out, target{id: cid, how: "closure"})
				continue
			}
		case *ast.Ident:
			if fn, ok := pk.Info.Uses[x].(*types.Func); ok {
				out = append(out, target{id: a.id(fn), how: "funcvalue"})
				continue
			}
		case *ast.SelectorExpr:
			if sel := pk.Info.Selections[x]; sel != nil && (sel.Kind() == types.MethodVal || sel.Kind() == types.MethodExpr) && !types.IsInterface(sel.Recv()) {
				out = append(out, target{id: a.id(sel.Obj()), how: "methodvalue", typ: typeName(sel.Recv())})
				continue
			}
			if fn, ok := pk.Info.Uses[x.Sel].(*types.Func); ok {
				out = append(out, target{id: a.id(fn), how: "funcvalue"})
				continue
			}
		}
		partial = true
	}
	if partial {
		for i := range out {
			out[i].partial = true
		}
	}
	return out
}

// dispatch: a method called through an interface. The values the receiver holds decide it when
// they are known; otherwise every type of the repository that implements the interface (checked by
// go/types, not by method name) is a candidate.
func (a *Analyzer) dispatch(pk *Pkg, call *ast.CallExpr, f *ast.SelectorExpr, recv types.Type, fn *types.Func, owner, mode string) {
	name := fn.Name()
	var v *types.Var
	switch x := unparen(f.X).(type) {
	case *ast.Ident:
		v, _ = pk.Info.Uses[x].(*types.Var)
	case *ast.SelectorExpr:
		if s := pk.Info.Selections[x]; s != nil && s.Kind() == types.FieldVal {
			v, _ = s.Obj().(*types.Var)
		}
	}
	prod := !a.isTest(call.Pos())
	if v != nil {
		if ts, how, ok := a.concrete(v, map[*types.Var]bool{}, prod); ok && len(ts) > 0 {
			var out []target
			seen := map[string]bool{}
			for _, t := range ts {
				if m, _ := methodOf(t, name); m != nil {
					id := a.id(m)
					if !seen[id] {
						seen[id] = true
						out = append(out, target{id: id, how: how, typ: typeName(t)})
					}
				}
			}
			if len(out) > 0 {
				a.emit(owner, call.Pos(), "call", mode, out, "inferred")
				return
			}
		}
	}
	iface, _ := recv.Underlying().(*types.Interface)
	// an interface of another module, or error: its implementations are mostly outside the
	// repository, so the call is to the interface method itself; the repository's own
	// implementations are linked to it by "implements" relations, not by a call at every site
	if fn.Pkg() == nil || a.pkgs[fn.Pkg().Path()] == nil {
		a.ifaceUsed[fn] = iface
		a.emit(owner, call.Pos(), "call", mode, []target{{id: a.ifaceID(fn, recv), how: "interface", typ: typeName(recv)}}, "exact")
		return
	}
	var out []target
	seen := map[string]bool{}
	for _, tn := range a.named {
		t := tn.Type()
		if types.IsInterface(t) || prod && a.isTest(tn.Pos()) {
			continue // a test's fake implements it only for the tests
		}
		if !types.Implements(t, iface) && !types.Implements(types.NewPointer(t), iface) {
			continue
		}
		if m, _ := methodOf(t, name); m != nil {
			id := a.id(m)
			if !seen[id] {
				seen[id] = true
				out = append(out, target{id: id, how: "interface", typ: tn.Name()})
			}
		}
	}
	if len(out) == 0 { // nothing in the production code implements it: the interface method itself
		a.emit(owner, call.Pos(), "call", mode, []target{{id: a.id(fn), how: "interface", typ: typeName(recv)}}, "exact")
		return
	}
	if len(out) > 1 {
		a.emitAmbiguous(owner, call.Pos(), mode, out)
		return
	}
	a.emit(owner, call.Pos(), "call", mode, out, "inferred")
}

// ifaceID: the node of an outside interface's method: error.Error, io.Writer.Write.
func (a *Analyzer) ifaceID(fn *types.Func, recv types.Type) string {
	p := ""
	if n, ok := recv.(*types.Named); ok && n.Obj().Pkg() != nil {
		p = n.Obj().Pkg().Path() + "."
	}
	name := p + typeName(recv) + "." + fn.Name()
	id := "ext:" + name
	if _, ok := a.nodes[id]; !ok {
		a.nodes[id] = &Node{Name: name, Defined: false, Kind: "interface method"}
	}
	a.ifaceRecv[fn] = recv
	return id
}

// implements: for each outside interface method called somewhere, the repository's methods that
// implement it, as relations of kind "implements" (method -> interface method). They say what
// may run behind an err.Error() without claiming that every call site reaches each of them.
func (a *Analyzer) implements() {
	for fn, iface := range a.ifaceUsed {
		recv := a.ifaceRecv[fn]
		dst := a.ifaceID(fn, recv)
		for _, tn := range a.named {
			t := tn.Type()
			if types.IsInterface(t) || !types.Implements(t, iface) && !types.Implements(types.NewPointer(t), iface) {
				continue
			}
			m, _ := methodOf(t, fn.Name())
			if m == nil {
				continue
			}
			src, ok := a.ids[m]
			if !ok {
				continue
			}
			n := a.nodes[src]
			a.edges = append(a.edges, Edge{Src: src, Dst: dst, File: n.File, Line: n.Line, Col: 1, Kind: "implements",
				Source: "static", Resolution: "exact", Infer: &Infer{How: "implements", Type: typeName(recv)}})
			a.counts["implements"]++
		}
	}
}

func (a *Analyzer) emitAmbiguous(owner string, pos token.Pos, mode string, ts []target) {
	file, line := a.rel(pos)
	col := a.fset.Position(pos).Column
	for _, t := range ts {
		e := Edge{Src: owner, Dst: t.id, File: file, Line: line, Col: col, Kind: "call", Source: "static", Resolution: "ambiguous", Mode: mode,
			Infer: &Infer{How: t.how, Type: t.typ, Partial: t.partial}}
		a.edges = append(a.edges, e)
		a.counts["ambiguous"]++
	}
}
