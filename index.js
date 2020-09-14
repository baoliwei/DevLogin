const puppeteer = require('puppeteer-core');
const {
	AsyncSeriesHook
 } = require("tapable");

 const init = Symbol('init')

class DevAutoLogin {
    constructor(userOptions, browserOptions, plugins) { // 初始化
        let args = [  // 启动 Chrome 的参数，详见上文中的介绍 
            '--ignore-certificate-errors', // 忽略证书认证出错
            '--ignore-ssl-errors',
            '--disable-gpu',   // 禁用GPU加速
            '--no-proxy-server', // 忽略代理
            '--disable-setuid-sandbox',
            '--remote-debugging-port=9222',
        ]
        const defaultBrowserOptions = {
            executablePath: this.getExecutePath(), // 可运行 Chromium 或 Chrome 可执行文件的路径
            ignoreHTTPSErrors: true, // 是否在导航期间忽略 HTTPS 错误. 默认是 false。
            headless: false,   // 有无浏览器界面启动
            slowMo: 0,       // 放慢浏览器执行速度，方便测试观察
            defaultViewport: null,
            ignoreDefaultArgs: ['--disable-extensions'], // 开启插件
            args: args,
            dumpio: true 
        }
        const defaultUserOptions = { // 用于获取登录凭证的配置
            cookies:['session'], // 要获取的cookie名称
            originSiteUrl: '', // 要获取cookie的url
            finalSiteUrl: '', // 要设置cookie的url
            userName: '', // 登录用户名
            password: '', // 登录密码
            verificationCode: '1', // 登录时的验证码
            closeDefaultLogin: false,
            closeDefaultVerificationCode: false,
            userNameEl: '#username', // 用户名输入框dom标识
            passwordEl: '#password', // 密码输入框dom标识
            loginEl: '.btn-submit', // 登录按钮dom标识
            verificationCodedEl: '#captcha', // 验证码输入框dom标识
            verificationCodeBtnEl: '.btn-submit' // 确认验证码按钮dom标识
        }
        this[init] = false
        this.plugins = plugins instanceof Array ? plugins : [] // plugins必须是数组，数组项必须是函数。
        browserOptions.args instanceof Array ? browserOptions.args.unshift(...args): null
        this.browserOptions = Object.assign(defaultBrowserOptions, browserOptions)
        this.userOptions = Object.assign(defaultUserOptions, userOptions)

        this.loginCert = [] // 登录凭证

        this.browser = null
        this.page = null

        this.hooks = {
			getLoginCert: new AsyncSeriesHook(['browser', 'page']) // 获取登录凭证
        }
        // this.run() // 启动
    }
    apply(compiler) { // 用于webpack调用
        compiler.hooks.done.tap('DevLoginPlugin', function(compilation) {
            if (!this[init]) {
                this.run()
            }
          }.bind(this));
    }
    async run () {
        this[init] = true
        await this.startBrowser()
        await this.startPage()
        await this.registerHook() // 注册hooks
        await this.autoLogin()
    }
    getExecutePath () {
        let path = {
            'darwin': '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome',  // mac
            'win32': 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // windows
            'default': '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome', 
        }
        return path[process.platform] ? path[process.platform] : path['default']
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
                ? result = await this.page.evaluate(item) || {}
                : result = await item.call(this, this.browser, this.page) || {} 
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
        // await this.page.setRequestInterception(true)
        this.page.on('error', (err) => { // 当页面崩溃时触发
            console.log('页面崩溃了...:', err)
        })
    
        this.page.on('pageerror', (err) => { // 当发生页面js代码没有捕获的异常时触发。
            console.log('页面js代码没有捕获的异常:', err)
        })
    
        this.page.on('requestfailed', (request) => {
            console.log('页面的请求失败:', request.url(), request.failure())
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
            this.page.goto(this.userOptions.finalSiteUrl),
            this.page.waitForNavigation({
                waitUntil: ['load', 'domcontentloaded', 'networkidle0']
            })
        ])
        console.log('已经登录完成...')
    }
    async gotoOriginSite(browser, page) { // 跳转至原始站点
        await Promise.all([ // 跳转至获取cookie的页面
            page.goto(this.userOptions.originSiteUrl),
            page.waitForNavigation({
                waitUntil: ['load', 'domcontentloaded', 'networkidle0']
            })
        ])
    }
    async login(browser, page) { // 登录
        await page.type(this.userOptions.userNameEl, this.userOptions.userName)
        await page.type(this.userOptions.passwordEl, this.userOptions.password)
        await Promise.all([
            page.click(this.userOptions.loginEl),
            page.waitForNavigation(['load', 'domcontentloaded', 'networkidle0'])
        ]);
    }
    async verificationCode(browser, page) { // 验证码
        await page.type(this.userOptions.verificationCodedEl, this.userOptions.verificationCode)
        await Promise.all([
            page.click(this.userOptions.verificationCodeBtnEl),
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
                    url: this.userOptions.finalSiteUrl
                })
            }
        }
    }
}

var path = require('path')
let pp = path.join('D:', 'software', 'PageSpeed Insights')
console.log(pp)
new DevAutoLogin({ // userOptions
    closeDefaultLogin: false,
    closeDefaultVerificationCode: true,
    cookies:['session'], // 要获取的cookie名称
    originSiteUrl: 'http://hhr_oms_testing.shanyishanmei.com', // 要获取cookie的url
    finalSiteUrl: 'http://localhost:8000/', // 要设置cookie的url
    userName: 'songrui001', // 登录用户名
    password: 'aaa111', // 登录密码
    verificationCode: '1' // 登录时的验证码
},
{
    args: [  // 启动 Chrome 的参数，详见上文中的介绍 
        '--allow-running-insecure-content', //允许不安全的脚本
        '--ignore-certificate-errors', // 忽略证书认证出错
        '--ignore-ssl-errors',
        '--disable-gpu',   // 禁用GPU加速      
        // '–no-sandbox',
        '--disable-setuid-sandbox',
        '--remote-debugging-port=9222', 
        '--flag-switches-begin',
        '--extensions-on-chrome-urls',
        '--flag-switches-end',
        '--enable-audio-service-sandbox',
        '--origin-trial-disabled-features=MeasureMemory',
        `--load-extension=${pp},C:\\Users\\baoliwei\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\ahfhijdlegdabablpippeagghigmibma\\0.3.0_0\\,C:\\Users\\baoliwei\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\nmmhkkegccagdldgiimedpiccmgmieda\\1.0.0.5_0\\,C:\\Users\\baoliwei\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\pkedcjkdefgpdelpbcmbmeomcjbeemfm\\8420.518.0.2_0\\`
    ],
  executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
}).run()

module.exports = DevAutoLogin;