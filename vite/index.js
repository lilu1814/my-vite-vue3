const fs = require('fs').promises
const Koa = require('koa')
const path = require('path')
const chalk = require('chalk')
const static = require('koa-static')
const { parse } = require('es-module-lexer')
const MagicString = require('magic-string')
const { Readable } = require('stream')

function addStyle(code){
  return `
        var css =  "${code.replace(/(\s|[\r\n])/g, '')}"
        var link = document.createElement('style')
        link.setAttribute('type', 'text/css')
        document.head.appendChild(link)
        link.innerHTML = css
      `
}

//读取body方法
async function readBody(stream) {
  if (stream instanceof Readable) {
    return new Promise((resolve) => {
      let res = ''
      stream.on('data', function (chunk) {
        res += chunk
      });
      stream.on('end', function () {
        resolve(res)
      })
    })
  } else {
    return stream;
  }
}

const resolvePlugin = [
  // 重写js
  ({ app, root }) => {
    function rewriteImports(source) {
      let imports = parse(source)[0]
      let ms = new MagicString(source);
      if (imports.length > 0) {
        for (let i = 0; i < imports.length; i++) {
          let { s, e } = imports[i]
          // 取 import 后面部分 例如 vue ./App.vue
          let id = source.slice(s, e)
          if (/^[^\/\.]/.test(id)) {
            //例如 vue 重写为 /@modules/vue
            id = `/@modules/${id}`;
            ms.overwrite(s, e, id)
          }
        }
      }
      return ms.toString();
    }
    app.use(async (ctx, next) => {
      await next();
      if (ctx.body && ctx.response.is('js')) {
        
        let r = await readBody(ctx.body)
        const result = rewriteImports(r);
        ctx.body = result;
      }
    })
  },
  //拦截/@modules 模块
  ({ app, root }) => {
    const reg = /^\/@modules\//
    app.use(async (ctx, next) => {
      if (!reg.test(ctx.path)) {
        return next();
      }
      const id = ctx.path.replace(reg, '')
      let mapping = {
        vue: path.resolve(root, 'node_modules', '@vue/runtime-dom/dist/runtime-dom.esm-browser.js')
      }
      const content = await fs.readFile(mapping[id], 'utf8');
      ctx.type = 'js'; // 返回的文件是js
      ctx.body = content;
    })
  },
  // 解析css 文件
  ({ app, root }) => {
    app.use(async (ctx, next) => {
      const filePath = path.join(root, ctx.path);
      const content = await fs.readFile(filePath, 'utf8');
      if (ctx.path.endsWith('.css')) {
       
        ctx.type = 'application/javascript'
        ctx.body = addStyle(content)
      } else {
        return next()
      }
    })
  },
  // 解析png 文件
  // ({ app, root }) => {
  //   app.use(async (ctx, next) => {
  //     const filePath = path.join(root, ctx.path);
  //     const content = await fs.readFile(filePath, 'utf8');
  //     if (ctx.path.endsWith('.png')) {
       
  //       ctx.type = 'image/png'
  //       ctx.body =  fileStream.createReadStream(filePath)
  //     } else {
  //       return next()
  //     }
  //   })
  // },
  
  // 解析.vue  文件
  ({ app, root }) => {
    app.use(async (ctx, next) => {
      const filePath = path.join(root, ctx.path);
      const content = await fs.readFile(filePath, 'utf8');

      if (!ctx.path.endsWith('.vue')) {
        return next()
      }

      // 引入.vue文件解析模板
      const { compileTemplate, parse ,compileStyle } = require(path.resolve(root, 'node_modules', '@vue/compiler-sfc/dist/compiler-sfc.cjs'))// commonjs
      let { descriptor } = parse(content);
      // console.log('descriptor',descriptor)
      if (!ctx.query.type) {
        let code = ''
        if (descriptor.script) {
          let content = descriptor.script.content;
          code += content.replace(/((?:^|\n|;)\s*)export default/, '$1const __script=');
        }
        if (descriptor.template) {
          const requestPath = ctx.path + `?type=template`;
          code += `\nimport { render as __render } from "${requestPath}"`;
          code += `\n__script.render = __render`
        }
        code += `\nimport "${ctx.path}?vue&type=style&index=0&id=xxxxxx"`
        code += `\nexport default __script`
        ctx.type = 'js';
        ctx.body = code
      }
      if (ctx.query.type == 'template') {
        ctx.type = 'js';
        let content = descriptor.template.content
        // <img alt="Vue logo" src="./assets/logo.png" />
        // <HelloWorld msg="Hello Vue 3.0 + Vite" />
        const { code } = compileTemplate({ source: content }); // 将app.vue中的模板 转换成render函数
        ctx.body = code;
      }
      if (ctx.query.type == 'style') {
        const styles = descriptor.styles.map(style=>{
          const {code} = compileStyle({ 
            source: style.content,
            id:ctx.query.id,
            scoped: style.scoped,
          }); // 将app.vue中的模板 转换成render函数
          return addStyle(code)
        })
       
        // <img alt="Vue logo" src="./assets/logo.png" />
        // <HelloWorld msg="Hello Vue 3.0 + Vite" />
       
        
        ctx.type = 'application/javascript'
        ctx.body = styles.join('\n')
        
      }
    })
  },
  // 静态服务器
  ({ app, root }) => {
    app.use(static(root))
    app.use(static(path.resolve(root, 'public')))
  }
]

function createServer() {
  let app = new Koa();
  const context = {
    app,
    root: process.cwd()
  }
  resolvePlugin.forEach(plugin => plugin(context))
  app.on('error', function(err) {
    if (process.env.NODE_ENV != 'test') {
      console.log('sent error %s to the cloud', err.message);
      console.error(err);
    }
  });
  return app
}

createServer().listen(4000, () => {
  console.log('dev server start')
  console.log(`>local ${chalk.cyan('http:localhost:4000')}`)
})