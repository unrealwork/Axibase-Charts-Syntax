import { Diagnostic, DiagnosticSeverity, Range, TextDocument } from "vscode-languageserver/lib/main";
import Import from "./Import";
import Statement from "./Statement";
import Util from "./Util";

// tslint:disable-next-line:no-var-requires
const jsdom = require("jsdom");
// tslint:disable-next-line:no-var-requires
const jquery = require("jquery");

export default class JsDomCaller {
    private static stringifyStatement(content: string): string {
        content = content.trim();
        if (!content.startsWith("return")) {
            content = "return " + content;
        }
        if (!content.endsWith(";")) {
            content = content + ";";
        }
        content = JSON.stringify(content);
        return content;
    }

    private static generateCall(amount: number, name: string): string {
        return "," + Array(amount).fill(name).join();
    }

    private document: TextDocument;
    private match: RegExpExecArray;
    private currentLineNumber: number = 0;
    private lines: string[];
    private statements: Statement[] = [];
    private imports: Import[] = [];
    private text: string;
    private dom: any;
    private jsModules: Map<string, any> = new Map<string, any>();

    constructor(document: TextDocument) {
        this.setDocument(document);
        this.dom = new jsdom.JSDOM("<html></html>", { runScripts: "outside-only" });
        this.dom.window.modules = this.jsModules;
        jquery(this.dom.window); // attach jquery
    }

    public setDocument(document: TextDocument) {
        this.document = document;
        this.text = Util.deleteComments(document.getText());
        this.lines = this.text.split("\n");
    }

    public validate(): Diagnostic[] {
        const result: Diagnostic[] = [];
        this.parseJsStatements();
        this.statements.forEach((statement) => {
            const call = `(new Function(${JSON.stringify(statement.declaration)})).call(window)`;
            try { this.dom.window.eval(call); } catch (err) {
                result.push(Util.createDiagnostic(
                    { range: statement.range, uri: this.document.uri },
                    DiagnosticSeverity.Warning, err.message,
                ));
            }
        });

        return result;
    }

    public async parseImports() {
        const regexp = /^[ \t]*import[ \t]+(\S+)[ \t]*=[ \t]*(\S+)$/gmi;
        const text = this.text;
        let match: RegExpExecArray = regexp.exec(text);
        const newImports: Import[] = [];
        const modules: Map<string, any> = new Map();
        while (match) {
            let url = match[2];
            const name = match[1];
            if (!/\//.test(url)) { url = "https://apps.axibase.com/chartlab/portal/resource/scripts/" + url; }
            for (const imp of this.imports) {
                if (imp.getUrl() === url) {
                    if (imp.getName() !== name) { imp.setName(name); }
                    newImports.push(imp);
                    match = regexp.exec(text);
                    continue;
                }
            }
            const external = new Import(name, url);

            let script;
            try { script = await external.getContent(); } catch (err) { return Promise.reject(err); }
            const thisModule = { exports: {} };
            const getModule = new Function("module, exports", script);
            getModule.apply(null, [thisModule, thisModule.exports]);
            modules.set(external.getName(), thisModule);

            newImports.push(external);
            match = regexp.exec(text);
        }
        this.imports = newImports;
        this.jsModules = modules;
        return Promise.resolve();
    }

    private getCurrentLine(): string { return this.getLine(this.currentLineNumber); }

    private getLine(i: number): string | null {
        if (i >= this.lines.length) { return null; }
        return this.lines[i];
    }

    private parseJsStatements() {
        this.statements = [];
        for (this.currentLineNumber = 0; this.currentLineNumber < this.lines.length; this.currentLineNumber++) {
            const line = this.getCurrentLine();
            this.match = /^[ \t]*script/.exec(line);
            if (this.match) {
                this.processScript();
                continue;
            }
            this.match = /(^[ \t]*replace-value[ \t]*=[ \t]*)(\S+[ \t\S]*)$/.exec(line);
            if (this.match) {
                this.processReplaceValue();
                continue;
            }
            this.match = /(^[ \t]*value[ \t]*=[ \t]*)(\S+[ \t\S]*)$/.exec(line);
            if (this.match) {
                this.processValue();
                continue;
            }
            this.match = /(^[ \t]*options[ \t]*=[ \t]*javascript:[ \t]*)(\S+[ \t\S]*)$/.exec(line);
            if (this.match) {
                this.processOptions();
            }
        }
    }

    private processScript() {
        let line = this.getCurrentLine();
        let content: string;
        let range: Range;
        this.match = /(^[ \t]*script[ \t]*=[\s]*)(\S+[\s\S]*)$/m.exec(line);
        if (this.match) {
            content = this.match[2];
            const matchStart = this.match[1].length;
            range = {
                end: { character: matchStart + this.match[2].length, line: this.currentLineNumber },
                start: { character: this.match[1].length, line: this.currentLineNumber },
            };
            let j = this.currentLineNumber + 1;
            while (!(/\bscript\b/.test(this.getLine(j)) || /\bendscript\b/.test(this.getLine(j)))) {
                j++;
                if (j >= this.lines.length) { break; }
            }
            if (!(j === this.lines.length || /\bscript\b/.test(this.getLine(j)))) {
                line = this.getLine(++this.currentLineNumber);
                while (line && !/\bendscript\b/.test(line)) {
                    line = this.getLine(++this.currentLineNumber);
                    content += line + "\n";
                }
                range.end = {
                    character: this.getLine(this.currentLineNumber - 1).length, line: this.currentLineNumber - 1,
                };
            }
        } else {
            range = {
                end: { character: this.getLine(this.currentLineNumber + 1).length, line: this.currentLineNumber + 1 },
                start: { character: 0, line: this.currentLineNumber + 1 },
            };
            content = "";
            line = this.getLine(++this.currentLineNumber);
            while (line && !/\bendscript\b/.test(line)) {
                line = this.getLine(++this.currentLineNumber);
                content += line + "\n";
            }
            range.end = {
                character: this.getLine(this.currentLineNumber - 1).length, line: this.currentLineNumber - 1,
            };
        }
        content = JSON.stringify(content);
        const statement = {
            declaration:
                `const proxy = new Proxy({}, {});` +
                `const proxyFunction = new Proxy(new Function(), {});` +
                `(new Function("widget","config","dialog", ${content}))` +
                `.call(window${JsDomCaller.generateCall(1, "proxyFunction")}${JsDomCaller.generateCall(2, "proxy")})`,
            range,
        };
        this.statements.push(statement);

    }

    private processReplaceValue() {
        const content = JsDomCaller.stringifyStatement(this.match[2]);
        const matchStart = this.match.index + this.match[1].length;
        const statement = {
            declaration:
                `(new Function("value","time","previousValue","previousTime", ${content}))\n` +
                `.call(window${JsDomCaller.generateCall(4, "5")})`,
            range: {
                end: { character: matchStart + this.match[2].length, line: this.currentLineNumber },
                start: { character: matchStart, line: this.currentLineNumber },
            },
        };
        this.statements.push(statement);
    }

    private processValue() {
        const content = JsDomCaller.stringifyStatement(this.match[2]);
        const matchStart = this.match.index + this.match[1].length;
        const keys = Array.from(this.jsModules.keys());
        const names: string = (keys.length > 0) ? '"' + keys.join() + '", ' : "";
        const modules: string =
            (keys.length > 0) ? "," + keys.map((name) => name = `modules.get("${name}")`).join() : "";
        const statement = {
            declaration:
                `const proxy = new Proxy({}, {});` +
                `const proxyFunction = new Proxy(new Function(), {});` +
                `const proxyArray = new Proxy([], {});` +
                `(new Function("metric","entity","tags","value","previous","movavg",` +
                `"detail","forecast","forecast_deviation","lower_confidence","upper_confidence",` +
                `"percentile","max","min","avg","sum","delta","counter","last","first",` +
                `"min_value_time","max_value_time","count","threshold_count","threshold_percent",` +
                `"threshold_duration","time","bottom","top","meta","entityTag","metricTag","median",` +
                `"average","minimum","maximum","series","getValueWithOffset","getValueForDate",` +
                `"getMaximumValue", ${names}${content}` +
                `)).call(window${JsDomCaller.generateCall(4, "proxy")}` +
                `${JsDomCaller.generateCall(33, "proxyFunction")}` +
                `${JsDomCaller.generateCall(1, "proxyArray")}` +
                `${JsDomCaller.generateCall(3, "proxyFunction")}` +
                `${modules})`,
            range: {
                end: { character: matchStart + this.match[2].length, line: this.currentLineNumber },
                start: { character: matchStart, line: this.currentLineNumber },
            },

        };
        this.statements.push(statement);
    }

    private processOptions() {
        const content = JsDomCaller.stringifyStatement(this.match[2]);
        const matchStart = this.match[1].length;
        const statement = {
            declaration:
                `const proxyFunction = new Proxy(new Function(), {});` +
                `(new Function("requestMetricsSeriesValues","requestEntitiesMetricsValues",` +
                `"requestPropertiesValues","requestMetricsSeriesOptions","requestEntitiesMetricsOptions",` +
                `"requestPropertiesOptions", ${content}` +
                `)).call(window${JsDomCaller.generateCall(6, "proxyFunction")})`,
            range: {
                end: { character: matchStart + this.match[2].length, line: this.currentLineNumber },
                start: { character: matchStart, line: this.currentLineNumber },
            },

        };
        this.statements.push(statement);
    }
}
