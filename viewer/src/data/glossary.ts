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
  'Execution context': { text: { 'zh-TW': '這個函式在哪個 thread 或迴圈裡執行、由誰觸發，以及因此不能做的事。', en: 'Which thread or loop runs the function, what triggers it, and what that forbids.' } },
  'Shared state': { text: { 'zh-TW': '函式之外、其他程式也能讀寫的資料：全域變數、static 變數、共用物件的欄位。多個 thread 同時存取時需要保護。', en: 'Data outside the function that other code can also read or write: globals, static variables, fields of a shared object.' } },
  'Parameters': { text: { 'zh-TW': '呼叫時傳進函式的值。用途說明資料往哪個方向流，傳遞方式說明語言怎麼把它交給函式。', en: 'The values passed in a call. The role says which way data flows; the passing says how the language hands it over.' } },
  'Return value': { text: { 'zh-TW': '函式結束時交回給呼叫端的值，以及每個值代表的意思。', en: 'What the function hands back when it ends, and what each value means.' } },
  'Side effects': { text: { 'zh-TW': '函式除了回傳值和參數以外，對外界造成的改變：寫檔、送出封包、印出訊息、配置或釋放記憶體。', en: 'What the function changes besides its return value and parameters: files, sockets, output, memory.' } },
  'Declaration': { text: { 'zh-TW': '寫在函式宣告上、由語言保證的特性，例如誰可以呼叫它、是不是 async。', en: 'What the declaration guarantees through the language: who may call it, whether it is async, and so on.' } },
  'Contract': { text: { 'zh-TW': '呼叫端與函式之間的協議：呼叫前要做到什麼、呼叫後保證什麼、出錯時怎樣、資源由誰釋放。', en: 'The agreement between caller and function: what must hold before, what holds after, what happens on failure, who frees what.' } },
  'in': { text: { 'zh-TW': '輸入：函式只讀取它，呼叫端傳進去的東西不會被改。', en: 'Input: the function only reads it; what the caller passed is not changed.' } },
  'out': { text: { 'zh-TW': '輸出：函式把結果寫進呼叫端提供的地方，呼叫前的內容不會被讀。', en: 'Output: the function writes its result into a place the caller provides; what was there is not read.' } },
  'in-out': { text: { 'zh-TW': '輸入輸出：函式先讀它，再把新的值寫回去，也叫 Pass by Value-Result。', en: 'In and out: the function reads it and writes a new value back; also called pass by value-result.' },
    ex: { c: 'socklen_t len = sizeof addr;\naccept(fd, &addr, &len);   /* len: in 是 buffer 大小，out 是實際長度 */' } },
  'Pass by Value': { text: { 'zh-TW': '函式拿到的是一份複本，改了不影響呼叫端。傳指標時複製的是位址，函式仍能經由位址改到呼叫端的資料。', en: 'The function gets a copy; changing it does not affect the caller. A pointer copies the address, so the data it points to can still be changed.' },
    ex: { c: 'void f(int n, int *p) { n = 1; *p = 1; }\nf(a, &b);   /* a 不變，b 變成 1 */', go: 'func f(s []int) { s = append(s, 1) }\nf(xs)   // len(xs) 不變', java: 'void f(int n) { n = 1; }   // 呼叫端的 int 不變' } },
  'Pass by Reference': { text: { 'zh-TW': '函式拿到的是呼叫端那個變數本身，改了就是改呼叫端的變數。', en: 'The function gets the caller\'s variable itself; changing it changes the caller\'s.' },
    ex: { c: 'void f(int &n) { n = 1; }\nf(a);   // a 變成 1' } },
  'Pass by Sharing': { text: { 'zh-TW': '函式拿到的是同一個物件：改它的內容呼叫端看得到，但在函式裡把參數改指向別的物件，呼叫端不受影響。', en: 'The function gets the same object: changing its contents shows to the caller, but rebinding the parameter does not.' },
    ex: { py: 'def f(xs):\n    xs.append(1)   # 呼叫端的 list 多一筆\n    xs = []        # 呼叫端不受影響', ts: 'function f(o) { o.n = 1; o = {} }   // 呼叫端的 o.n 變成 1', java: 'void f(List<Integer> xs) { xs.add(1); }   // 呼叫端看得到' } },
  'move': { text: { 'zh-TW': 'C++ 的 && 參數：呼叫端的東西被拿走，之後不該再使用。', en: 'A C++ && parameter: the function takes over what the caller passed, which should not be used afterwards.' } },
  'precondition': { text: { 'zh-TW': '呼叫前必須成立的條件，沒做到時函式的行為沒有保證。', en: 'What must hold before the call; without it the function promises nothing.' } },
  'postcondition': { text: { 'zh-TW': '函式正常結束後保證成立的事。', en: 'What holds after the function returns normally.' } },
  'ownership': { text: { 'zh-TW': '資源由誰負責釋放：記憶體由誰 free、檔案或 socket 由誰 close。', en: 'Who releases a resource: who frees the memory, who closes the file or socket.' } },
  'static local': { text: { 'zh-TW': '函式裡加了 static 的區域變數：呼叫之間會保留值，所以同時從兩個 thread 呼叫、或遞迴呼叫時要小心。', en: 'A local variable declared static: it keeps its value between calls, so concurrent or recursive calls share it.' },
    ex: { c: 'int next(void) { static int n = 0; return ++n; }   /* 1, 2, 3 ... */' } },
}

/** What each declaration keyword means, keyed as signature.py names them. */
export const KEYWORDS: Record<string, L> = {
  'static': { 'zh-TW': 'static：只有這個檔案能呼叫（C、C++ 的函式），或不需要物件就能呼叫（類別的方法）。', en: 'static: only this file can call it (a C or C++ function), or it is called without an object (a class method).' },
  'extern-linkage': { 'zh-TW': '沒有 static：其他檔案也能呼叫（external linkage）。', en: 'Not static: other files can call it too (external linkage).' },
  'extern': { 'zh-TW': 'extern：定義在別的檔案。', en: 'extern: defined in another file.' },
  'inline': { 'zh-TW': 'inline：編譯器可以把函式本體直接展開在呼叫的地方。', en: 'inline: the compiler may expand the body where it is called.' },
  'virtual': { 'zh-TW': 'virtual：實際執行哪個版本，要到執行時看物件的型別才決定。', en: 'virtual: which version runs is decided at run time by the object\'s type.' },
  'override': { 'zh-TW': 'override：取代父類別的同名方法。', en: 'override: replaces the parent class\'s method of this name.' },
  'final': { 'zh-TW': 'final：子類別不能再覆寫它。', en: 'final: subclasses cannot override it.' },
  'const': { 'zh-TW': 'const 方法：不會修改物件的欄位。', en: 'const method: does not change the object\'s fields.' },
  'noexcept': { 'zh-TW': 'noexcept：承諾不丟出例外。', en: 'noexcept: promises not to throw.' },
  'constexpr': { 'zh-TW': 'constexpr：可以在編譯時計算。', en: 'constexpr: can be evaluated at compile time.' },
  'public': { 'zh-TW': 'public：任何地方都能呼叫。', en: 'public: callable from anywhere.' },
  'private': { 'zh-TW': 'private：只有同一個類別能呼叫。', en: 'private: only its own class can call it.' },
  'protected': { 'zh-TW': 'protected：同一個類別和子類別能呼叫。', en: 'protected: its class and subclasses can call it.' },
  'abstract': { 'zh-TW': 'abstract：沒有本體，由子類別實作。', en: 'abstract: no body; subclasses implement it.' },
  'abstractmethod': { 'zh-TW': 'abstractmethod：由子類別實作。', en: 'abstractmethod: subclasses implement it.' },
  'synchronized': { 'zh-TW': 'synchronized：同一時間只有一個 thread 能執行它（對同一個物件）。', en: 'synchronized: one thread at a time runs it (per object).' },
  'default': { 'zh-TW': 'default：interface 提供的預設實作。', en: 'default: an interface\'s default implementation.' },
  'export': { 'zh-TW': 'export：其他模組可以 import 它。', en: 'export: other modules can import it.' },
  'readonly': { 'zh-TW': 'readonly。', en: 'readonly.' },
  'async': { 'zh-TW': 'async：呼叫後拿到的是 Promise 或 coroutine，要 await 才會得到結果。', en: 'async: a call returns a promise or coroutine; await it for the result.' },
  'generator': { 'zh-TW': 'generator：呼叫時函式不會馬上執行，而是在逐一取值時才執行到下一個 yield。', en: 'generator: a call does not run it; it runs up to the next yield each time a value is taken.' },
  'staticmethod': { 'zh-TW': 'staticmethod：不需要物件就能呼叫，也碰不到物件的欄位。', en: 'staticmethod: called without an object and cannot reach its fields.' },
  'classmethod': { 'zh-TW': 'classmethod：拿到的是類別本身（cls），不是物件。', en: 'classmethod: receives the class itself (cls), not an object.' },
  'property': { 'zh-TW': 'property：像欄位一樣讀取，不用加括號呼叫。', en: 'property: read like a field, without calling it.' },
  'internal': { 'zh-TW': '名稱以底線開頭：依慣例只在模組或類別內部使用，Python 不會阻止外部呼叫。', en: 'A leading underscore: by convention for internal use only; Python does not enforce it.' },
  'exported': { 'zh-TW': '名稱以大寫開頭（exported）：其他 package 可以使用。', en: 'Capitalized (exported): other packages can use it.' },
  'unexported': { 'zh-TW': '名稱以小寫開頭：只有同一個 package 能使用。', en: 'Lower-case: only its own package can use it.' },
  'receiver-pointer': { 'zh-TW': 'pointer receiver：方法裡改了欄位，呼叫端的物件也會跟著變。', en: 'Pointer receiver: changes to fields show in the caller\'s object.' },
  'receiver-value': { 'zh-TW': 'value receiver：方法拿到物件的複本，改了欄位不影響呼叫端。', en: 'Value receiver: the method gets a copy; changing fields does not affect the caller.' },
  'variadic': { 'zh-TW': '可變長度參數：呼叫時可以傳任意多個值。', en: 'Variadic: a call may pass any number of values.' },
}

export const conceptText = (k: string) => (CONCEPTS[k] ? local(CONCEPTS[k].text) : '')
export const conceptEx = (k: string, lang?: string) => CONCEPTS[k]?.ex?.[exLang(lang)]
export const keywordText = (k: string) => (KEYWORDS[k] ? local(KEYWORDS[k]) : k)
