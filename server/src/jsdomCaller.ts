import { get as getHttp } from "http";
import { RequestOptions as httpOptions } from "http";
import { get as getHttps } from "https";
import { RequestOptions as httpsOptions } from "https";
import { Diagnostic, DiagnosticSeverity, Range, TextDocument } from "vscode-languageserver/lib/main";
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

    private static downloadScriptHttps(options: httpsOptions): Promise<string> {
        return new Promise<string>((success, error) => {
            getHttps(options, (message) => {
                message.on("data", (body) => {
                    if (typeof body !== "string") { body = body.toString(); }
                    success(body);
                });
                message.on("error", error);
            });
        });
    }

    private static downloadScriptHttp(options: httpOptions): Promise<string> {
        return new Promise<string>((success, error) => {
            getHttp(options, (message) => {
                message.on("data", (body) => {
                    if (typeof body !== "string") { body = body.toString(); }
                    success(body);
                });
                message.on("error", error);
            });
        });
    }

    private httpOptions: httpOptions[] = [];
    private httpsOptions: httpsOptions[] = [];
    private document: TextDocument;
    private match: RegExpExecArray;
    private currentLineNumber: number = 0;
    private lines: string[];
    private result: Diagnostic[] = [];
    private statements: Statement[] = [];
    private imports: string[] = [];
    private importCounter = 0;

    constructor(document: TextDocument) {
        this.document = document;
        this.lines = Util.deleteComments(document.getText()).split("\n");
    }

    public async validate(): Promise<Diagnostic[]> {
        this.parseJsStatements();

        const scripts: string[] = await Promise.all(this.httpsOptions.map(JsDomCaller.downloadScriptHttps));
        const httpScripts: string[] = await Promise.all(this.httpOptions.map(JsDomCaller.downloadScriptHttp));
        scripts.concat(httpScripts);
        const dom = new jsdom.JSDOM("<html></html>", { runScripts: "dangerously", resources: "usable" });
        const window = dom.window;
        const js = [jquery(dom.window)];
        scripts.forEach((script) => {
            const thisModule = { exports: {}};
            const getModule = new Function("module, exports", script);
            getModule.apply(null, [thisModule, thisModule.exports]);
            js.push(thisModule);
        });
        this.statements.forEach((statement) => {
            const call = `(new Function("$", "${this.imports.join(",")}", ${JSON.stringify(statement.declaration)}))` +
            `.call(window, ${js.join()})`;
            try { window.eval(call); } catch (err) {
                let isImported = false;
                for (const imported of this.imports) {
                    if (new RegExp(imported, "i").test(err.message)) {
                        isImported = true;
                        break;
                    }
                }
                if (!isImported) {
                    this.result.push(Util.createDiagnostic(
                        { range: statement.range, uri: this.document.uri },
                        DiagnosticSeverity.Warning, err.message,
                    ));
                }
            }
        });

        return this.result;
    }

    private getCurrentLine(): string {
        return this.getLine(this.currentLineNumber);
    }

    private getLine(i: number): string | null {
        if (i >= this.lines.length) { return null; }
        return this.lines[i].toLowerCase();
    }

    private urlToOptions(url: string) {
        this.match = /^http(s?):\/\/(\S+?)(\/\S*)$/.exec(url);
        if (!this.match) { return; }
        const hostname = this.match[2];
        const path = this.match[3];
        if (this.match[1] === "s") {
            this.httpsOptions.push({ hostname, path });
        } else {
            this.httpOptions.push({ hostname, path });
        }
    }

    private parseJsStatements() {
        for (; this.currentLineNumber < this.lines.length; this.currentLineNumber++) {
            const line = this.getCurrentLine();
            this.match = /^[ \t]*script/.exec(line);
            if (this.match) {
                this.processScript();
                continue;
            }
            this.match = /^[ \t]*import[ \t]+(\S+)[ \t]*=\s*(\S+)\s*$/.exec(line);
            if (this.match) {
                this.imports.push(this.match[1]);
                let url = this.match[2];
                if (!/\//.test(url)) {
                    url = "https://apps.axibase.com/chartlab/portal/resource/scripts/" + url;
                }
                this.urlToOptions(url);
                this.importCounter++;
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
        const importList = '"' + this.imports.join('","') + '"';
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
                `"getMaximumValue", ${importList}, ${content}` +
                `)).call(window${JsDomCaller.generateCall(4, "proxy")}` +
                `${JsDomCaller.generateCall(33, "proxyFunction")}` +
                `${JsDomCaller.generateCall(1, "proxyArray")}` +
                `${JsDomCaller.generateCall(3, "proxyFunction")}` +
                `${JsDomCaller.generateCall(this.importCounter, "proxy")})`,
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
