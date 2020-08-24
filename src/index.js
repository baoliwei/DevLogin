const puppeteer = require('puppeteer');
const {
	AsyncSeriesHook
 } = require("tapable");

 const init = Symbol('init')

class DevLoginPlugin {
    constructor(userOptions, browserOptions, plugins) { // 初始化
        const defaultBrowserOptions = {
            // executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // 可运行 Chromium 或 Chrome 可执行文件的路径
            ignoreHTTPSErrors: true, // 是否在导航期间忽略 HTTPS 错误. 默认是 false。
            headless: false,   // 有无浏览器界面启动
            slowMo: 0,       // 放慢浏览器执行速度，方便测试观察
            defaultViewport: null,
            args: [  // 启动 Chrome 的参数，详见上文中的介绍 
                '--ignore-certificate-errors', // 忽略证书认证出错
                '--ignore-ssl-errors',
                '--disable-gpu',   // 禁用GPU加速      
                '–no-sandbox',
                '--disable-setuid-sandbox',
                '--remote-debugging-port=9222', 
            ],
            dumpio: true 
        }
        const defaultUserOptions = { // 用于获取登录凭证的配置
            cookies:['session'], // 要获取的cookie名称
            getCookieUrl: '', // 要获取cookie的url
            setCookieUrl: '', // 要设置cookie的url
            userName: '', // 登录用户名
            password: '', // 登录密码
            verificationCode: '1', // 登录时的验证码
            closeDefaultLogin: false,
            closeDefaultVerificationCode: false
        }
        this[init] = false
        this.plugins = plugins instanceof Array ? plugins : [] // plugins必须是数组，数组项必须是函数。
        this.browserOptions = Object.assign(defaultBrowserOptions, browserOptions, userOptions)
        this.userOptions = Object.assign(defaultUserOptions, userOptions)

        this.loginCert = [] // 登录凭证

        this.browser = null
        this.page = null

        this.hooks = {
			getLoginCert: new AsyncSeriesHook(['browser', 'page']) // 获取登录凭证
        }
        // this.apply() // 启动
    }
    async apply() { // 用于webpack调用
        compiler.hooks.done.tapAsync('DevLoginPlugin', async function(compilation, callback) {
            if (this[init]) {
                callback()
                return
            }
            this[init] = true
            await this.startBrowser()
            await this.startPage()
            await this.registerHook() // 注册hooks
            await this.autoLogin()
            callback()
          }.bind(this));
    }
    async registerHook() { // 注册hook
        // 跳转至原始站点
        this.hooks.getLoginCert.tapPromise('gotoOriginSite', this.gotoOriginSite.bind(this, this.browser, this.page))
        // 运行插件方法
        this.hooks.getLoginCert.tapPromise('runPlugins', this.runPlugins.bind(this, this.browser, this.page))
        // 对原始站点进行登录
        if (!this.userOptions.closeDefaultLogin) { // 设置了关闭默认的登录，则不注册默认登录，默认关闭
            this.hooks.getLoginCert.tapPromise('loginDefault', this.login.bind(this, this.browser, this.page))
        }

        if (!this.userOptions.closeDefaultVerificationCode) { // 设置了关闭默认的验证码，则不注册默认验证码输入，默认关闭
            this.hooks.getLoginCert.tapPromise('verificationCodeDefault', this.verificationCode.bind(this, this.browser, this.page))
        }

        // 获取原始站点登录凭证
        this.hooks.getLoginCert.tapPromise('makeLoginCert', this.makeLoginCert.bind(this, this.browser, this.page))
    }
    async runPlugins() { // 运行插件方法
        for (let index = 0; index < this.plugins.length; index++) {
            let result = null
            let item = this.plugins[index]
            typeof item === 'function'
            && item.length === 0 
                ? result = await item.call(this, this.browser, this.page) || {} 
                : result = await this.page.evaluate(item) || {}
            if (result.nextPage) { // 如果需要跳转至下一个页面
                await this.page.waitForNavigation(['load', 'domcontentloaded', 'networkidle0'])
            }

            if (result.loginCert) { // 拿到最终的登录凭证
                this.loginCert = result.loginCert
                break
            }
            
        }
    }
    async callHook() { // 获取cookie
        await this.hooks.getLoginCert.promise(this.browser, this.page)
    }
    async startBrowser() { // 启动浏览器
        console.log('浏览器启动中...')
        this.browser = await puppeteer.launch(this.browserOptions); // 启动浏览器
        console.log('浏览器启动成功...')
    }
    async startPage() { // 启动一个页面
        this.page = await this.browser.newPage(); // 新建一个页面
        
        this.page.on('error', (err) => { // 当页面崩溃时触发
            console.log('页面崩溃了...:', err)
        })
    
        this.page.on('pageerror', (err) => { // 当发生页面js代码没有捕获的异常时触发。
            console.log('页面js代码没有捕获的异常:', err)
        })
    
        this.page.on('requestfailed', (request) => {
            console.log('页面的请求失败:', request.url())
        })

        this.page.on('console', msg => {
            for (let i = 0; i < msg.args().length; ++i){
                console['log'](`${i}: ${msg.args()[i]}`)
            } 
        });
    }
    async autoLogin() { // 自动登录
        console.log('开始登录了...')
        
        await this.callHook() // 进行获取原始登录凭证钩子调用

        await this.transferLoginCert(this.loginCert) // 转移凭证至最终的站点

        await Promise.all([ // 跳转至最终的站点
            this.page.goto(this.userOptions.setCookieUrl),
            this.page.waitForNavigation({
                waitUntil: ['load', 'domcontentloaded', 'networkidle0']
            })
        ])
        console.log('已经登录完成...')
    }
    async gotoOriginSite(browser, page) { // 跳转至原始站点
        await Promise.all([ // 跳转至获取cookie的页面
            page.goto(this.userOptions.getCookieUrl),
            page.waitForNavigation({
                waitUntil: ['load', 'domcontentloaded', 'networkidle0']
            })
        ])
    }
    async login(browser, page) { // 登录
        await page.type('#username', this.userOptions.userName)
        await page.type('#password', this.userOptions.password)
        await Promise.all([
            page.click('.btn-submit'),
            page.waitForNavigation(['load', 'domcontentloaded', 'networkidle0'])
        ]);
    }
    async verificationCode(browser, page) { // 验证码
        await page.type('#captcha', this.userOptions.verificationCode)
        await Promise.all([
            page.click('.btn-submit'),
            page.waitForNavigation(['load', 'domcontentloaded', 'networkidle0'])
        ]);
        
    }
    async makeLoginCert() {// 得到原始登录凭证
        this.loginCert = await this.page.cookies() // 拿到cookie
    }
    async transferLoginCert(cookies) { // 转移登录凭证至最终站点，设置cookie
        for(let i = 0; i< cookies.length; i++) {
            if(this.userOptions.cookies.includes(cookies[i].name.toLowerCase())) {
                console.log(cookies[i].name)
                await this.page.setCookie({
                    name: cookies[i].name,
                    value: cookies[i].value,
                    expires: cookies[i].expires,
                    url: this.userOptions.setCookieUrl
                })
            }
        }
    }
}
new DevLoginPlugin(
    {
        closeDefaultLogin: true,
        closeDefaultVerificationCode: true,
        cookies:['session'], // 要获取的cookie名称
        getCookieUrl: 'final url', // 要获取cookie的url
        // getCookieUrl: 'final url', // 要获取cookie的url
        setCookieUrl: 'http://localhost:8001/', // 要设置cookie的url
        userName: 'username', // 登录用户名
        password: 'password', // 登录密码
        verificationCode: '1' // 登录时的验证码
    },
    null,
    [
        function (A) {
            document.querySelector('#username').value = 'username'
            document.querySelector('#password').value = 'password'
            let btn = document.querySelector('.btn-submit')
            btn.click()
            return {nextPage: true}
        },
        function (A) {
            document.querySelector('#captcha').value = '1'
            // document.querySelector('#password').value = 'aaa111'
            let btn = document.querySelector('.btn-submit')
            btn.click()
            return {nextPage: true}
        }
    ]
)
module.exports = DevLoginPlugin;