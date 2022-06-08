
import { assert, isSimpleName, unwrapExp, detectExpressionType, xNode, trimEmptyNodes } from "../utils";


export function makeFragment(node) {
    let rx = node.value.match(/#fragment\:(\S+)(.*)$/s);
    assert(rx);
    let name = rx[1], external = false;
    assert(isSimpleName(name));
    let props = rx[2] ? rx[2].trim() : null;
    if(props) {
        props = props.split(/[\s,]+/).filter(p => {
            if(p == 'export') {
                external = true;
                return false;
            }
            return true;
        });
    }

    let block;
    if(node.body && node.body.length) block = this.buildBlock({body: trimEmptyNodes(node.body)}, {inline: true, context: 'fragment'});
    else {
        this.warning(`Empty fragment: '${node.value}'`);
        return xNode('empty-fragment', {name}, (ctx, n) => {
            ctx.writeLine(`function $fragment_${n.name}() {};`);
        });
    }

    if(external) {
      this.require('$component');
      if(props?.length) this.require('apply');
    }

    return xNode('fragment', {
        name,
        props,
        external,
        source: block.source,
        template: xNode('template', {
            name: '$parentElement',
            body: block.tpl,
            svg: block.svg
        })
    }, (ctx, n) => {
        ctx.write(true, `function $fragment_${n.name}($cd, $$label, $props, $events, $$fragmentSlot) {\n`);
        ctx.indent++;

        if(n.props?.length) {
            if(ctx.inuse.apply) {
                ctx.writeLine('let ' + n.props.join(', ') + ';');
                ctx.writeLine(`$runtime.unwrapProps($cd, $props, ($$) => ({${n.props.join(', ')}} = $$));`);
            } else {
                ctx.writeLine('let ' + n.props.join(', ') + ';');
                ctx.writeLine(`$props && ({${n.props.join(', ')}} = ($runtime.isFunction($props) ? $props() : $props));`);
            }
        }

        ctx.build(n.template);
        ctx.build(n.source);
        ctx.writeLine(`$runtime.insertAfter($$label, $parentElement);`);

        ctx.indent--;
        ctx.writeLine('}');
        if(n.external) ctx.writeLine(`$runtime.exportFragment($component, '${n.name}', $fragment_${n.name});`);
    });
}


function parseAttibutes(attributes) {
    let props = [];
    let events = [];
    let forwardAllEvents;
    let staticProps = true;

    attributes.forEach(prop => {
        let name = prop.name;

        if(name[0] == '@' || name.startsWith('on:')) {
            if(name.startsWith('@@')) {
                this.require('$events');
                if(name == '@@') forwardAllEvents = true;
                else {
                    name = name.substring(2);
                    events.push({
                        name,
                        callback: `$events?.${name}`
                    });
                }
                return;
            }

            let {event, fn} = this.makeEventProp(prop);
            events.push({name: event, fn});
        } else {
            let ip = this.inspectProp(prop);
            props.push(ip);
            if(!ip.static) staticProps = false;
        }
    });

    return {props, events, forwardAllEvents, staticProps};
}


export function attachFragment(node, element) {
    let name = node.elArg;
    assert(isSimpleName(name));

    let slotBlock = null;

    if(node.body?.length) slotBlock = this.buildBlock({body: trimEmptyNodes(node.body)}, {inline: true});

    let {props, events, forwardAllEvents, staticProps} = parseAttibutes.call(this, node.attributes);
    this.require('$cd');

    let slot = null;
    if(slotBlock) {
        let template = xNode('template', {
            name: '$parentElement',
            body: slotBlock.tpl,
            svg: slotBlock.svg,
            inline: !slotBlock.source
        });

        slot = {
            source: slotBlock.source,
            template
        }
    }

    return xNode('call-fragment', {
        forwardAllEvents,
        el: element.bindName(),
        name,
        events,
        props,
        slot,
        staticProps
    }, (ctx, n) => {
        ctx.write(true, `$fragment_${n.name}($cd, ${n.el}`);
        let missed = '';
        ctx.indent++;

        if(n.props.length) {
            ctx.write(',\n', true);

            const writeProps = () => ctx.write('{' + n.props.map(p => p.name == p.value ? p.name : `${p.name}: ${p.value}`).join(', ') + '}');

            if(n.staticProps) writeProps();
            else {
                ctx.write(`() => (`);
                writeProps();
                ctx.write(`)`);
            }
        } else missed = ', 0';

        if(n.forwardAllEvents) {
            if(n.events.length) this.warning(`Fragment: mixing binding and forwarding is not supported: '${node.openTag}'`);
            ctx.write(missed, ', $events');
            missed = '';
        } else if(n.events.length) {
            ctx.write(missed, ',\n', true, '{');
            missed = '';

            n.events.forEach((e, i) => {
                if(i) ctx.write(', ');
                if(e.callback) {
                    if(e.name == e.callback) ctx.write(e.name);
                    ctx.write(`${e.name}: ${e.callback}`);
                } else {
                    assert(e.fn);
                    ctx.write(`${e.name}: `);
                    ctx.build(e.fn);
                }
            });
            ctx.write('}');
        } else missed += ', 0';

        if(n.slot) {
            ctx.write(missed, ',\n');
            missed = '';
            if(n.slot.source) {
                ctx.writeLine(`($cd, $$label) => {`);
                ctx.goIndent(() => {
                    ctx.build(n.slot.template);
                    ctx.build(n.slot.source);
                    ctx.writeLine(`$runtime.insertAfter($$label, $parentElement);`);
                });
                ctx.write(true, `}`);
            } else {
                ctx.write(true, `($cd, $$label) => $runtime.insertAfter($$label, `);
                ctx.build(n.slot.template);
                ctx.write(`)\n`);
            }
        }

        ctx.indent--;
        if(n.props.length || n.events.length || n.slot) ctx.write(true, ');\n');
        else ctx.write(');\n');

    });
};


export function attachFragmentSlot(label) {
    this.require('$cd');

    return xNode('fragment-slot', {
        el: label.bindName()
    }, (ctx, n) => {
        ctx.writeLine(`$$fragmentSlot?.($cd, ${n.el});`)
    });
};


export function attchExportedFragment(node, label, componentName) {
    this.require('$cd');

    let data = {
        name: node.elArg,
        componentName,
        label: label.bindName(),
    };

    let body = trimEmptyNodes(node.body || []);
    if(body.length) {
        let block = this.buildBlock({body}, {inline: true});
        assert(!block.svg, 'SVG is not supported for exported fragment');
        data.source = block.source;
        data.template = xNode('template', {
            raw: true,
            body: block.tpl
        });
    }

    let pa = parseAttibutes.call(this, node.attributes);
    data.props = pa.props;
    data.events = pa.events;
    data.forwardAllEvents = pa.forwardAllEvents;
    data.staticProps = pa.staticProps;

    return xNode('attach-exported-fragment', data, (ctx, n) => {
        ctx.write(true, `$runtime.attchExportedFragment($cd, $instance_${n.componentName}, '${n.name}', ${n.label}`);
        let missed = '';
        ctx.indent++;

        if(n.props.length) {
            ctx.write(',\n', true);

            const writeProps = () => ctx.write('{' + n.props.map(p => p.name == p.value ? p.name : `${p.name}: ${p.value}`).join(', ') + '}');

            if(n.staticProps) writeProps();
            else {
                ctx.write(`$runtime.observeProps(`);
                if(this.config.immutable) ctx.write(`$runtime.keyComparator`);
                else ctx.write(`$runtime.$$compareDeep`);
                ctx.write(', () => (');
                writeProps();
                ctx.write('))');
            }
        } else missed = ', 0';

        if(n.forwardAllEvents) {
            if(n.events.length) this.warning(`Fragment: mixing binding and forwarding is not supported: '${node.openTag}'`);
            ctx.write(missed, ', $events');
            missed = '';
        } else if(n.events.length) {
            ctx.write(missed, ',\n', true, '{');
            missed = '';

            n.events.forEach((e, i) => {
                if(i) ctx.write(', ');
                if(e.callback) {
                    if(e.name == e.callback) ctx.write(e.name);
                    ctx.write(`${e.name}: ${e.callback}`);
                } else {
                    assert(e.fn);
                    ctx.write(`${e.name}: `);
                    ctx.build(e.fn);
                }
            });
            ctx.write('}');
        } else missed += ', 0';

        if(n.template) {
            if(missed) ctx.write(missed, `, \``);
            else ctx.write(`,\n`, true, `\``);
            ctx.build(n.template);
            if(n.source) {
                ctx.write(`\`, ($cd, $parentElement) => {\n`);
                ctx.indent++;
                ctx.build(n.source);
                ctx.indent--;
                ctx.writeLine(`});`);
            } else {
                ctx.write(`\`);\n`);
            }
        } else ctx.write(');\n');
        ctx.indent--;
    });
}
