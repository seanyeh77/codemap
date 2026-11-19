// The words the function panel uses about how code works: built into codemap, not written by an AI, since they are
// the languages' own concepts. Each has a short explanation in both languages and, where it helps, a minimal
// example in the language of the function being read.
import { local } from '../i18n'

type L = Record<string, string>
export interface Concept { text: L; ex?: Partial<Record<Lang, string>> }
export type Lang = 'c' | 'py' | 'go' | 'ts' | 'java'

/** The function's language as the examples are keyed: C++ uses the C examples. */
export const exLang = (lang?: string): Lang =>
  lang === 'python' ? 'py' : lang === 'go' ? 'go' : lang === 'java' ? 'java' : lang === 'typescript' || lang === 'javascript' ? 'ts' : 'c'

export const CONCEPTS: Record<string, Concept> = {
  'Execution context': { text: { 'zh-TW': '函式所在的 thread 或迴圈、觸發方式，以及由此產生的限制。', en: 'Which thread or loop runs the function, what triggers it, and what that forbids.' } },
  'Shared state': { text: { 'zh-TW': '函式以外、其他程式碼亦可讀寫的資料，例如全域變數、static 變數與共用物件的欄位。多個 thread 同時存取時須加以保護。', en: 'Data outside the function that other code can also read or write: globals, static variables, fields of a shared object.' } },
  'Parameters': { text: { 'zh-TW': '呼叫時傳入函式的值。用途：資料的流向；傳遞方式：語言將值交給函式的方式。', en: 'The values passed in a call. The role says which way data flows; the passing says how the language hands it over.' } },
  'Return value': { text: { 'zh-TW': '函式結束時交回呼叫端的值及其意義。', en: 'What the function hands back when it ends, and what each value means.' } },
  'Side effects': { text: { 'zh-TW': '回傳值與參數以外，函式對外界造成的改變，例如寫入檔案、送出封包、輸出訊息、配置或釋放記憶體。', en: 'What the function changes besides its return value and parameters: files, sockets, output, memory.' } },
  'Declaration': { text: { 'zh-TW': '函式宣告上由語言保證的特性，例如可呼叫的範圍、是否為 async。', en: 'What the declaration guarantees through the language: who may call it, whether it is async, and so on.' } },
  'Contract': { text: { 'zh-TW': '呼叫端與函式之間的約定：呼叫前須成立的條件、呼叫後的保證、錯誤處理，以及資源的釋放責任。', en: 'The agreement between caller and function: what must hold before, what holds after, what happens on failure, who frees what.' } },
  'in': { text: { 'zh-TW': '輸入：函式僅讀取，不修改呼叫端傳入的資料。', en: 'Input: the function only reads it; what the caller passed is not changed.' } },
  'out': { text: { 'zh-TW': '輸出：函式將結果寫入呼叫端提供的位置，不讀取原有內容。', en: 'Output: the function writes its result into a place the caller provides; what was there is not read.' } },
  'in-out': { text: { 'zh-TW': '輸入輸出：函式先讀取，再寫回新的值，亦稱 Pass by Value-Result。', en: 'In and out: the function reads it and writes a new value back; also called pass by value-result.' },
    ex: { c: 'socklen_t len = sizeof addr;\naccept(fd, &addr, &len);   /* len：傳入 buffer 大小，傳回實際長度 */' } },
  'Pass by Value': { text: { 'zh-TW': '函式取得複本，修改不影響呼叫端。傳入指標時複製的是位址，函式仍可經由位址修改呼叫端的資料。', en: 'The function gets a copy; changing it does not affect the caller. A pointer copies the address, so the data it points to can still be changed.' },
    ex: { c: 'void f(int n, int *p) { n = 1; *p = 1; }\nf(a, &b);   /* a 不變，b 為 1 */', go: 'func f(s []int) { s = append(s, 1) }\nf(xs)   // len(xs) 不變', java: 'void f(int n) { n = 1; }   // 呼叫端的 int 不變' } },
  'Pass by Reference': { text: { 'zh-TW': '函式取得呼叫端的變數本身，修改即改變呼叫端的變數。', en: 'The function gets the caller\'s variable itself; changing it changes the caller\'s.' },
    ex: { c: 'void f(int &n) { n = 1; }\nf(a);   // a 為 1' } },
  'Pass by Sharing': { text: { 'zh-TW': '函式取得同一個物件：修改其內容會反映到呼叫端；將參數改為指向其他物件則不影響呼叫端。', en: 'The function gets the same object: changing its contents shows to the caller, but rebinding the parameter does not.' },
    ex: { py: 'def f(xs):\n    xs.append(1)   # 呼叫端的 list 增加一筆\n    xs = []        # 不影響呼叫端', ts: 'function f(o) { o.n = 1; o = {} }   // 呼叫端的 o.n 為 1', java: 'void f(List<Integer> xs) { xs.add(1); }   // 呼叫端可見' } },
  'move': { text: { 'zh-TW': 'C++ 的 && 參數：函式接管呼叫端傳入的資源，呼叫端此後不應再使用。', en: 'A C++ && parameter: the function takes over what the caller passed, which should not be used afterwards.' } },
  'precondition': { text: { 'zh-TW': '呼叫前必須成立的條件；未滿足時函式的行為不受保證。', en: 'What must hold before the call; without it the function promises nothing.' } },
  'postcondition': { text: { 'zh-TW': '函式正常結束後保證成立的條件。', en: 'What holds after the function returns normally.' } },
  'ownership': { text: { 'zh-TW': '資源的釋放責任，例如由誰 free 記憶體、由誰 close 檔案或 socket。', en: 'Who releases a resource: who frees the memory, who closes the file or socket.' } },
  'static local': { text: { 'zh-TW': '宣告為 static 的區域變數：在多次呼叫之間保留其值，因此並行或遞迴呼叫時須留意。', en: 'A local variable declared static: it keeps its value between calls, so concurrent or recursive calls share it.' },
    ex: { c: 'int next(void) { static int n = 0; return ++n; }   /* 1, 2, 3 ... */' } },
  // the kinds of definition the 定義 view lists
  'struct': { text: { 'zh-TW': '將多個欄位組成一個型別，各欄位有各自的記憶體位置。', en: 'A type made of several fields, each with its own place in memory.' },
    ex: { c: 'struct ring { int head; char buf[64]; };\nstruct ring r;\nr.head = 0;', go: 'type Ring struct { Head int; Buf []byte }' } },
  'union': { text: { 'zh-TW': '多個欄位共用同一塊記憶體，同一時間只有一個欄位的值有意義。', en: 'Fields that share one piece of memory: only one of them holds a meaningful value at a time.' },
    ex: { c: 'union val { int i; float f; };\nunion val v;\nv.i = 1;   /* 此後讀取 v.f 無意義 */' } },
  'enum': { text: { 'zh-TW': '一組具名的常數，用名稱取代數字。', en: 'A set of named constants that stand for numbers.' },
    ex: { c: 'enum color { RED, GREEN = 3 };   /* RED 為 0 */', ts: 'enum Dir { Up, Down }', java: 'enum E { A, B }' } },
  'typedef': { text: { 'zh-TW': '為既有型別另取名稱，不產生新的型別。', en: 'Another name for an existing type; it makes no new type.' },
    ex: { c: 'typedef unsigned int u32;\nu32 n = 1;   /* 與 unsigned int 相同 */' } },
  'macro': { text: { 'zh-TW': '前置處理器在編譯前做的文字替換，以 #define 定義。帶參數的巨集看似函式呼叫，但參數是直接代入文字。', en: 'Text the preprocessor substitutes before compiling, defined with #define. A macro with parameters looks like a call, but its arguments are pasted in as text.' },
    ex: { c: '#define MAX_CTX 16\n#define SQ(x) ((x) * (x))\nSQ(a + 1)   /* 展開為 ((a + 1) * (a + 1)) */' } },
  'extern': { text: { 'zh-TW': '宣告變數存在於其他檔案，本檔案只引用，不配置記憶體。', en: 'Says the variable lives in another file: this file only refers to it and allocates nothing.' },
    ex: { c: '/* a.c */ int g_n;\n/* a.h */ extern int g_n;' } },
  'static variable': { text: { 'zh-TW': '在函式外宣告為 static 的變數：只有本檔案的程式碼可以使用，整個程式執行期間只有一份。', en: 'A variable declared static outside any function: only this file can use it, and the program has one copy of it.' },
    ex: { c: 'static int hits;   /* 其他 .c 檔案看不到 */' } },
  'global variable': { text: { 'zh-TW': '在函式外宣告的變數：整個程式只有一份，其他檔案以 extern 宣告後也能使用。', en: 'A variable declared outside any function: the program has one copy, and other files can use it after an extern declaration.' } },
  'module variable': { text: { 'zh-TW': '在模組最外層指定的變數：同一模組的函式都能讀取，以 global 宣告後才能重新指定。', en: 'A variable assigned at the top of a module: its functions can read it, and reassign it after a global statement.' },
    ex: { py: 'count = 0\ndef hit():\n    global count\n    count += 1' } },
  'include': { text: { 'zh-TW': '前置處理器將另一個檔案的內容插入此處。引號表示專案內的檔案，角括號表示系統或程式庫的標頭檔。', en: 'The preprocessor pastes another file in here. Quotes name a file of the project; angle brackets a system or library header.' },
    ex: { c: '#include "ring.h"\n#include <stdio.h>' } },
  'export': { text: { 'zh-TW': '模組開放給其他模組使用的名稱。', en: 'A name a module lets other modules use.' },
    ex: { ts: 'export const MAX_N = 10', py: '__all__ = ["Ring"]', go: 'func Read() {}   // 大寫開頭即匯出' } },
}

/** What each declaration keyword means, keyed as signature.py names them. */
export const KEYWORDS: Record<string, L> = {
  'static': { 'zh-TW': 'static：僅限本檔案呼叫（C、C++ 函式），或無須物件即可呼叫（類別方法）。', en: 'static: only this file can call it (a C or C++ function), or it is called without an object (a class method).' },
  'extern-linkage': { 'zh-TW': '未宣告 static：其他檔案亦可呼叫（external linkage）。', en: 'Not static: other files can call it too (external linkage).' },
  'extern': { 'zh-TW': 'extern：定義於其他檔案。', en: 'extern: defined in another file.' },
  'inline': { 'zh-TW': 'inline：編譯器可將函式本體展開於呼叫處。', en: 'inline: the compiler may expand the body where it is called.' },
  'virtual': { 'zh-TW': 'virtual：執行的版本於執行時依物件型別決定。', en: 'virtual: which version runs is decided at run time by the object\'s type.' },
  'override': { 'zh-TW': 'override：覆寫父類別的同名方法。', en: 'override: replaces the parent class\'s method of this name.' },
  'final': { 'zh-TW': 'final：子類別不得覆寫。', en: 'final: subclasses cannot override it.' },
  'const': { 'zh-TW': 'const 方法：不修改物件的欄位。', en: 'const method: does not change the object\'s fields.' },
  'noexcept': { 'zh-TW': 'noexcept：保證不擲出例外。', en: 'noexcept: promises not to throw.' },
  'constexpr': { 'zh-TW': 'constexpr：可於編譯時求值。', en: 'constexpr: can be evaluated at compile time.' },
  'public': { 'zh-TW': 'public：任何位置皆可呼叫。', en: 'public: callable from anywhere.' },
  'private': { 'zh-TW': 'private：僅限同一類別呼叫。', en: 'private: only its own class can call it.' },
  'protected': { 'zh-TW': 'protected：限同一類別與子類別呼叫。', en: 'protected: its class and subclasses can call it.' },
  'abstract': { 'zh-TW': 'abstract：無本體，由子類別實作。', en: 'abstract: no body; subclasses implement it.' },
  'abstractmethod': { 'zh-TW': 'abstractmethod：由子類別實作。', en: 'abstractmethod: subclasses implement it.' },
  'synchronized': { 'zh-TW': 'synchronized：同一物件同一時間僅允許一個 thread 執行。', en: 'synchronized: one thread at a time runs it (per object).' },
  'default': { 'zh-TW': 'default：interface 提供的預設實作。', en: 'default: an interface\'s default implementation.' },
  'export': { 'zh-TW': 'export：其他模組可 import。', en: 'export: other modules can import it.' },
  'readonly': { 'zh-TW': 'readonly。', en: 'readonly.' },
  'async': { 'zh-TW': 'async：呼叫後取得 Promise 或 coroutine，須 await 才能取得結果。', en: 'async: a call returns a promise or coroutine; await it for the result.' },
  'generator': { 'zh-TW': 'generator：呼叫時不立即執行，每次取值時執行至下一個 yield。', en: 'generator: a call does not run it; it runs up to the next yield each time a value is taken.' },
  'staticmethod': { 'zh-TW': 'staticmethod：無須物件即可呼叫，且無法存取物件的欄位。', en: 'staticmethod: called without an object and cannot reach its fields.' },
  'classmethod': { 'zh-TW': 'classmethod：取得類別本身（cls），而非物件。', en: 'classmethod: receives the class itself (cls), not an object.' },
  'property': { 'zh-TW': 'property：以欄位方式讀取，無須加括號呼叫。', en: 'property: read like a field, without calling it.' },
  'internal': { 'zh-TW': '名稱以底線開頭：依慣例僅供模組或類別內部使用，Python 不限制外部呼叫。', en: 'A leading underscore: by convention for internal use only; Python does not enforce it.' },
  'exported': { 'zh-TW': '名稱以大寫開頭（exported）：其他 package 可使用。', en: 'Capitalized (exported): other packages can use it.' },
  'unexported': { 'zh-TW': '名稱以小寫開頭：僅限同一 package 使用。', en: 'Lower-case: only its own package can use it.' },
  'receiver-pointer': { 'zh-TW': 'pointer receiver：方法對欄位的修改會反映到呼叫端的物件。', en: 'Pointer receiver: changes to fields show in the caller\'s object.' },
  'receiver-value': { 'zh-TW': 'value receiver：方法取得物件的複本，修改欄位不影響呼叫端。', en: 'Value receiver: the method gets a copy; changing fields does not affect the caller.' },
  'variadic': { 'zh-TW': '可變長度參數：呼叫時可傳入任意數量的值。', en: 'Variadic: a call may pass any number of values.' },
}

export const conceptText = (k: string) => (CONCEPTS[k] ? local(CONCEPTS[k].text) : '')
export const conceptEx = (k: string, lang?: string) => CONCEPTS[k]?.ex?.[exLang(lang)]
export const keywordText = (k: string) => (KEYWORDS[k] ? local(KEYWORDS[k]) : k)
