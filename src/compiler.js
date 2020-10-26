
import { assert, compactDOM, replace } from './utils.js'
import { parse } from './parser';
import { transformJS } from './code';
import { buildRuntime } from './builder';
import { processCSS } from './css/index';

export const version = '0.5.27';

export function compile(src, config = {}) {
    config = Object.assign({
        name: 'widget',
        warning: (w) => console.warn('!', w.message),
        exportDefault: true,
        inlineTemplate: false,
        hideLabel: false,
        compact: true,
        autoSubscribe: true,
        cssGenId: null
    }, config);

    const data = parse(src);

    let script = data.body.filter(n => n.type == 'script');
    assert(script.length <= 1, 'Only one script section');

    script = transformJS(script[0] ? script[0].content : null, config);

    const css = processCSS(data.body.filter(n => n.type == 'style'), config);

    data.body = data.body.filter(n => n.type != 'script' && n.type != 'style');
    if(config.compact) compactDOM(data);
    const runtime = buildRuntime(data, script, css, config);

    let code = `
        import * as $runtime from 'malinajs/runtime.js';
        import { $watch, $watchReadOnly, $tick } from 'malinajs/runtime.js';
    `;

    if(config.hideLabel) {
        code += `import { $$htmlToFragmentClean as $$htmlToFragment } from 'malinajs/runtime.js';\n`;
    } else {
        code += `import { $$htmlToFragment } from 'malinajs/runtime.js';\n`;
    }

    if(config.injectRuntime) code += config.injectRuntime + '\n';

    let scriptCode = replace(script.code, '$$runtimeHeader()', runtime.header, 1);
    scriptCode = replace(scriptCode, '$$runtime()', runtime.body, 1);
    return code + scriptCode;
};
