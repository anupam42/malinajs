
import { assert, detectExpressionType, isSimpleName, unwrapExp, xNode, last, toCamelCase, replaceElementKeyword } from '../utils.js'


export function bindProp(prop, node, element) {
    let name, arg;
    if(prop.name[0] == '@' || prop.name.startsWith('on:')) name = 'event';
    if(!name && prop.name[0] == ':') {
        name = 'bind';
        arg = prop.name.substring(1);
    }
    if(!name && prop.name[0] == '*') {
        let rx = prop.name.match(/^\*\{.*\}$/);
        if(rx) {
            assert(prop.value == null, 'wrong binding: ' + prop.content);
            name = 'use';
            prop.value = prop.name.substring(1);
        } else {
            name = 'use';
            arg = prop.name.substring(1);
        }
    }
    if(prop.content.startsWith('{*')) {
        const pe = this.parseText(prop.content);
        assert(pe.parts[0].type == 'js');
        let exp = pe.parts[0].value;
        if(!exp.endsWith(';')) exp += ';';
        return {bind: xNode('block', {body: [
            replaceElementKeyword(exp, () => element.bindName())
        ]})};
    }
    if(!name && prop.value == null) {
        let rx = prop.name.match(/^\{(.*)\}$/);
        if(rx) {
            name = rx[1];
            if(name.startsWith('...')) {
                // spread operator
                name = name.substring(3);
                assert(detectExpressionType(name) == 'identifier');
                this.detectDependency(name);
                return node.spreading.push(`...${name}`);
            } else {
                prop.value = prop.name;
            }
        }
    }
    if(!name) {
        let r = prop.name.match(/^(\w+)\:(.*)$/)
        if(r) {
            name = r[1];
            arg = r[2];
        } else name = prop.name;
    }

    const isExpression = s => s[0] == '{' && last(s) == '}';

    const getExpression = () => {
        let exp = prop.value.match(/^\{(.*)\}$/)[1];
        assert(exp, prop.content);
        return exp;
    }

    if(name[0] == '#') {
        let target = name.substring(1);
        assert(isSimpleName(target), target);
        this.checkRootName(target);
        return {bind: `${target}=${element.bindName()};`};
    } else if(name == 'event') {
        if(prop.name.startsWith('@@')) {
            assert(!prop.value);
            this.require('$cd', '$events');
            if(prop.name == '@@') {
                return {bind: xNode('forwardAllEvents', {
                    el: element.bindName()
                }, (ctx, data) => {
                    ctx.writeLine(`for(let event in $events)`);
                    ctx.goIndent(() => {
                        ctx.writeLine(`$runtime.addEvent($cd, ${data.el}, event, $events[event]);`);
                    });
                })};
            }

            return {bind: xNode('forwardEvent', {
                event: prop.name.substring(2),
                el: element.bindName()
            }, (ctx, n) => {
                ctx.writeLine(`$events.${n.event} && $runtime.addEvent($cd, ${n.el}, '${n.event}', $events.${n.event});`);
            })};
        }

        let {event, fn} = this.makeEventProp(prop, () => element.bindName());

        this.require('$cd');

        return {bind: xNode('bindEvent', {
            event,
            fn,
            el: element.bindName()
        }, (ctx, n) => {
            ctx.write(true, `$runtime.addEvent($cd, ${n.el}, '${n.event}', `);
            ctx.build(n.fn);
            ctx.write(`);\n`);
        })};
    } else if(name == 'bind') {
        if(this.script.readOnly) {
            this.warning('script read-only conflicts with bind: ' + node.openTag);
            return;
        }

        this.require('apply', '$cd');
        let exp;
        arg = arg.split(/[\:\|]/);
        let attr = arg.shift();
        assert(attr, prop.content);

        if(prop.value) exp = getExpression();
        else {
            if(arg.length) exp = arg.pop();
            else exp = attr;
        }
        let inputType = null;
        if(node.name == 'input') {
            node.attributes.some(a => {
                if(a.name == 'type') {
                    inputType = a.value;
                    return true;
                }
            });
        }

        assert(['value', 'checked', 'valueAsNumber', 'valueAsDate', 'selectedIndex'].includes(attr), 'Not supported: ' + prop.content);
        assert(arg.length == 0);
        assert(detectExpressionType(exp) == 'identifier', 'Wrong bind name: ' + prop.content);
        if(attr == 'value' && ['number', 'range'].includes(inputType)) attr = 'valueAsNumber';
        this.detectDependency(exp);

        let argName = 'a' + (this.uniqIndex++);

        return {bind: xNode('bindInput', {
            el: element.bindName()
        }, (ctx, n) => {
            ctx.writeLine(`$runtime.bindInput($cd, ${n.el}, '${attr}', () => ${exp}, ${argName} => {${exp} = ${argName}; $$apply();});`);
        })};
    } else if(name == 'style' && arg) {
        let styleName = arg;
        let exp;
        if(prop.value) {
            if(isExpression(prop.value)) {
                exp = getExpression();
                this.detectDependency(exp);
            } else {
                if(prop.value.includes('{')) {
                    const parsed = this.parseText(prop.value);
                    this.detectDependency(parsed);
                    exp = parsed.result;
                } else {
                    return {bind: xNode('staticStyle', {
                        el: element.bindName(),
                        name: styleName,
                        value: prop.value
                    }, (ctx, n) => {
                        ctx.writeLine(`${n.el}.style.${toCamelCase(n.name)} = \`${this.Q(n.value)}\`;`);
                    })};
                }
            }
        } else {
            exp = toCamelCase(styleName);
        }

        let hasElement = exp.includes('$element');
        return {bind: xNode('block', {
            scope: hasElement,
            body: [xNode('bindStyle', {
                el: element.bindName(),
                styleName,
                exp,
                hasElement
            }, (ctx, n) => {
                if(n.hasElement) ctx.writeLine(`let $element=${n.el};`);
                if(ctx.inuse.apply) {
                    ctx.writeLine(`$runtime.bindStyle($cd, ${n.el}, '${n.styleName}', () => (${n.exp}));`);
                } else {
                    ctx.writeLine(`${n.el}.style.${toCamelCase(n.styleName)} = ${n.exp};`);
                }
            })]
        })};
    } else if(name == 'use') {
        if(arg) {
            this.require('$cd');
            assert(isSimpleName(arg), 'Wrong name: ' + arg);
            this.checkRootName(arg);
            let args = prop.value ? `, () => [${getExpression()}]` : '';
            this.detectDependency(args);
            return {bind: xNode('action', {
                name: arg,
                args,
                el: element.bindName()
            }, (ctx, n) => {
                if(ctx.inuse.apply && n.args) {
                    ctx.writeLine(`$runtime.bindAction($cd, ${n.el}, ${n.name}${n.args}, $runtime.__bindActionSubscribe);`);
                } else {
                    ctx.writeLine(`$runtime.bindAction($cd, ${n.el}, ${n.name}${n.args});`);
                }
            })}
        }
        let exp = getExpression();
        this.detectDependency(exp);
        let hasElement = exp.includes('$element');
        return {bind: xNode('inline-action', {
            exp,
            el: hasElement && element.bindName(),
            element,
            hasElement
        }, (ctx, n) => {
            ctx.writeLine(`$tick(() => {`);
            ctx.goIndent(() => {
                if(n.hasElement) ctx.writeLine(`let $element=${n.el};`);
                ctx.writeLine(n.exp);
                if(ctx.inuse.apply) ctx.writeLine('$$apply();');
            });
            ctx.writeLine(`});`);
        })}
    } else if(name == 'class') {
        if(node.__skipClass) return {};
        node.__skipClass = true;

        let props = node.attributes.filter(a => a.name == 'class' || a.name.startsWith('class:'));

        let compound = false;
        props.forEach(prop => {
            let classes = [];
            if(prop.name == 'class') {
                if(!prop.value) return;
                let parsed = this.parseText(prop.value);
                for(let p of parsed.parts) {
                    if(p.type == 'text') {
                        classes = classes.concat(p.value.trim().split(/\s+/));
                    } else if(p.type == 'exp') compound = true;
                }
            } else {
                classes = [prop.name.slice(6)];
            }
            return this.config.passClass && classes.some(name => {
                if(this.css.isExternalClass(name)) compound=true;
                else if(name[0] == '$') {
                    this.css.markAsExternal(name.substring(1));
                    compound = true;
                }
            });
        });

        if(compound) {
            let defaultHash = '';
            if(node.classes.has(this.css.id)) defaultHash = this.css.id;
            node.classes.clear();
            if(this.config.passClass) this.require('resolveClass');
            let exp = props.map(prop => {
                if(prop.name == 'class') {
                    return this.parseText(prop.value).result;
                } else {
                    let className = prop.name.slice(6);
                    assert(className);
                    let exp = prop.value ? unwrapExp(prop.value) : className;
                    this.detectDependency(exp);
                    return `(${exp}) ? \`${this.Q(className)}\` : ''`;
                }
            }).join(') + \' \' + (');
            const bind = xNode('compound-class', {
                el: element.bindName(),
                exp,
                defaultHash
            }, (ctx, n) => {
                if(ctx.inuse.resolveClass) {
                    let base = n.defaultHash ? `,'${n.defaultHash}'` : '';
                    if(ctx.inuse.apply) {
                        ctx.writeLine(`$watchReadOnly($cd, () => $$resolveClass((${n.exp})${base}), value => $runtime.setClassToElement(${n.el}, value));`);
                    } else {
                        ctx.writeLine(`$runtime.setClassToElement(${n.el}, $$resolveClass((${n.exp})${base}));`);
                    }
                } else {
                    let base = n.defaultHash ? ` + ' ${n.defaultHash}'` : '';
                    if(ctx.inuse.apply) {
                        ctx.writeLine(`$watchReadOnly($cd, () => ${n.exp}${base}, value => $runtime.setClassToElement(${n.el}, value));`);
                    } else {
                        ctx.writeLine(`$runtime.setClassToElement(${n.el}, ${n.exp}${base});`);
                    }
                }
            });
            return {bind};
        } else {
            let bind = xNode('block');
            props.forEach(prop => {
                if(prop.name == 'class') {
                    prop.value && prop.value.trim().split(/\s+/).forEach(name => {
                        node.classes.add(name);
                    });
                } else {
                    let className = prop.name.slice(6);
                    assert(className);
                    let exp = prop.value ? unwrapExp(prop.value) : className;
                    this.detectDependency(exp);
                    bind.push(xNode('bindClass', {
                        el: element.bindName(),
                        className,
                        exp,
                        $element: exp.includes('$element')
                    }, (ctx, n) => {
                        if(n.$element) {
                            ctx.writeLine(`{`);
                            ctx.indent++;
                            ctx.writeLine(`let $element = ${n.el};`)
                        }
                        if(ctx.inuse.apply) {
                            ctx.writeLine(`$runtime.bindClass($cd, ${n.el}, () => !!(${n.exp}), '${n.className}');`)
                        } else {
                            ctx.writeLine(`(${n.exp}) && $runtime.addClass(${n.el}, '${n.className}');`)
                        }
                        if(n.$element) {
                            ctx.indent--;
                            ctx.writeLine(`}`);
                        }
                    }));
                }
            });
            return {bind: bind.body.length ? bind : null};
        }
    } else if(name[0] == '^') {
        this.require('$cd');
        return {bindTail: xNode('bindAnchor', {
            name: name.slice(1) || 'default',
            el: element.bindName()
        }, (ctx, n) => {
            ctx.writeLine(`$runtime.attachAnchor($option, $cd, '${n.name}', ${n.el});`)
        })};
    } else {
        if(prop.value && prop.value.indexOf('{') >= 0) {
            const parsed = this.parseText(prop.value);
            this.detectDependency(parsed);
            let exp = parsed.result;
            let hasElement = prop.value.includes('$element');

            if(node.spreading) return node.spreading.push(`${name}: ${exp}`);

            const propList = {
                hidden: true,
                checked: true,
                value: true,
                disabled: true,
                selected: true,
                innerHTML: true,
                innerText: true,
                src: true,
                readonly: 'readOnly'
            }

            return {bind: xNode('block', {
                scope: hasElement,
                body: [
                    xNode('bindAttribute', {
                        name,
                        exp,
                        hasElement,
                        el: element.bindName()
                    }, (ctx, data) => {
                        if(data.hasElement) ctx.writeLine(`let $element=${data.el};`);
                        if(propList[name]) {
                            let propName = propList[name] === true ? name : propList[name];
                            if(ctx.inuse.apply) {
                                ctx.writeLine(`$watchReadOnly($cd, () => (${data.exp}), (value) => {${data.el}.${propName} = value;});`);
                            } else {
                                ctx.writeLine(`${data.el}.${propName} = ${data.exp};`);
                            }
                        } else {
                            if(ctx.inuse.apply) {
                                ctx.writeLine(`$runtime.bindAttribute($cd, ${data.el}, '${data.name}', () => (${data.exp}));`);
                            } else {
                                ctx.writeLine(`$runtime.bindAttributeBase(${data.el}, '${data.name}', ${data.exp});`);
                            }
                        }
                    })
                ]
            })};
        }

        if(node.spreading) return node.spreading.push(`${name}: \`${this.Q(prop.value)}\``);

        element.attributes.push({
            name: prop.name,
            value: prop.value
        });
    }
};
