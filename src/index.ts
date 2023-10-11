import { Bot } from "grammy";
import { format } from 'date-fns';

async function getProjectCache(projecturl: string, env) {
  let _projectcache = await env.JSKV.get(`project:${projecturl}`);
  if (_projectcache != null) {  // KV查到
    return JSON.parse(_projectcache);
  }
  else {
    // 开始查询项目信息
    const js_result = await env.DB.prepare(`SELECT projectcode,obfuscate_enable,obfuscate_code,telegram_notice_enable,telegram_notice_token,telegram_notice_chatid FROM projects WHERE projects.projecturl = ? AND projects.enabled = 1`)
      .bind(projecturl).first();
    if (js_result != null && js_result.projectcode != null) {  // 数据库查到
      const { projectcode, obfuscate_enable, obfuscate_code, telegram_notice_enable, telegram_notice_token, telegram_notice_chatid } = js_result;
      let moduleargs: string[] = [];
      // 从数据库查询project对应的module_extra_argname
      const module_result = await env.DB.prepare(`SELECT modules.module_extra_argname FROM modules JOIN project_modules ON modules.moduleid = project_modules.moduleid JOIN projects ON project_modules.projectid = projects.projectid WHERE projects.projecturl = ? AND modules.module_extra_argname IS NOT NULL`)
        .bind(projecturl).all().then((query_result: any) => {
          return query_result.results.map((row: any) => ({ module_extra_argname: row.module_extra_argname }));
        });
      for (const key in Array.from(module_result)) {
        moduleargs.push(module_result[key]['module_extra_argname']);
      }
      // 缓存到KV
      const projectcache = {
        'projectcode': obfuscate_enable == 1 && obfuscate_code != '' ? obfuscate_code : projectcode,
        'moduleargs': moduleargs,
        'telegram': {
          'telegram_notice_enable': telegram_notice_enable,
          'telegram_notice_token': telegram_notice_token,
          'telegram_notice_chatid': telegram_notice_chatid
        }
      };
      await env.JSKV.put(`project:${projecturl}`, JSON.stringify(projectcache));
      return projectcache;
    }
    return null;
  }
}

function checkURL(url: string) {
  const req_url = new URL(url).pathname.substring(1);
  const fileExtensions = ['.png', '.jpg', '.gif'];
  const isImage = fileExtensions.some(extension => req_url.endsWith(extension));
  const isFourDigitAlphaNumeric = /^[a-z0-9]{4}$/;
  if (isImage) {
    const fileName = req_url.substring(0, req_url.lastIndexOf('.'));
    if (isFourDigitAlphaNumeric.test(fileName)) {
      // 为图片请求
      return { 'isImage': true, projecturl: fileName, 'check': true }
    }
  }
  else if (isFourDigitAlphaNumeric.test(req_url)) {
    // 为project请求
    return { 'isImage': false, projecturl: req_url, 'check': true }
  }
  return { 'isImage': false, projecturl: '', 'check': false };
}

async function sendTelegram(telegramData, reqData) {
  const token = telegramData.telegram_notice_token;
  const chatid = telegramData.telegram_notice_chatid;
  const Data = `ID: \`${reqData.id}\`\n` +
    `URL: \`${reqData.referer}\`\n` +
    `请求IP: \`${reqData.ip}\`\n` +
    `UserAgent: \`${reqData.useragent}\`\n` +
    `国家: \`${reqData.country}\`\n` +
    `省份: \`${reqData.region}\`\n` +
    `时间: \`${format(reqData.requestdate, 'yyyy-MM-dd HH:mm:ss')}\``;
  const bot = new Bot(token);
  await bot.api.sendMessage(chatid,
    Data,
    { parse_mode: "MarkdownV2" }
  );
}
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

async function handleOptions(request) {
  if (
    request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null &&
    request.headers.get("Access-Control-Request-Headers") !== null
  ) {
    // Handle CORS preflight requests.
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Headers": request.headers.get(
          "Access-Control-Request-Headers"
        ),
      },
    });
  } else {
    // Handle standard OPTIONS request.
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, POST, OPTIONS",
      },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    let response = new Response(""); //默认返回空包
    try {
      
      // 处理OPTIONS跨域
      if (request.method === "OPTIONS") {
        // Handle CORS preflight requests
        return handleOptions(request);
      }

      //检查URL
      const checkResult = checkURL(request.url);
      if (!checkResult.check) { // URL不满足条件,返回空
        return response;
      }
      // GET请求,且无图片后缀名
      if (request.method == 'GET' && !checkResult.isImage) {
        let projectcode = "";
        const projectcache = await getProjectCache(checkResult.projecturl, env);
        if (projectcache) {
          projectcode = projectcache.projectcode;
        }
        response = new Response(projectcode, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "content-type": "text/javascript",
            "Cache-Control": "s-maxage=3600"
          },
        });
        return response;
      }
      else if (  // POST回传数据请求 或图片探测请求
        (request.method == 'POST' && !checkResult.isImage)
        ||
        (request.method == 'GET' && checkResult.isImage)
      ) {
        response = new Response("", {
          headers: {
            "Access-Control-Allow-Origin": "*"
          }
        });
        const projectcache = await getProjectCache(checkResult.projecturl, env);
        if (projectcache == null) {  // KV未查到
          return response;
        }
        let res_json = {}
        let otherdata_json = {};
        let req_id = request.headers.get('cf-ray') ? request.headers.get('cf-ray') : Date.now().toString();
        if (request.method == 'POST' && request.headers.get("content-type").includes("application/x-www-form-urlencoded")) {
          try {
            res_json = await request.json();
            for (const key of projectcache.moduleargs) {
              if (res_json.hasOwnProperty(key)) {
                otherdata_json[key] = res_json[key].toString();
              } else {
                otherdata_json[key] = '';
              }
            }
          } catch (e: any) {
          }
        } else {
          req_id = 'img_' + req_id;
        }
        let req_data = {
          id: req_id,
          projecturl: checkResult.projecturl,
          country: request.cf.country ? request.cf.country : '',
          region: request.cf.region ? request.cf.region : '',
          city: request.cf.city ? request.cf.city : '',
          isp: request.cf.asOrganization ? request.cf.asOrganization : '',
          latitude: request.cf.latitude ? request.cf.latitude : '',
          longitude: request.cf.longitude ? request.cf.longitude : '',
          referer: request.headers.get('Referer') ? request.headers.get('Referer') : "",
          domain: request.headers.get('Referer') ? new URL(request.headers.get('Referer')).hostname : "",
          ip: request.headers.get('x-real-ip') ? request.headers.get('x-real-ip') : "255.255.255.255",
          useragent: request.headers.get('user-agent') ? request.headers.get('user-agent') : "",
          requestdate: Date.now(),
          otherdata: JSON.stringify(otherdata_json)
        };
        const success = await env.DB.prepare(`
          INSERT INTO accesslog (id, projecturl, country, region, city, isp, latitude, longitude, referer, domain, ip, useragent, requestdate, otherdata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            req_data.id,
            req_data.projecturl,
            req_data.country,
            req_data.region,
            req_data.city,
            req_data.isp,
            req_data.latitude,
            req_data.longitude,
            req_data.referer,
            req_data.domain,
            req_data.ip,
            req_data.useragent,
            req_data.requestdate,
            req_data.otherdata
          ).run();
        if (projectcache.telegram.telegram_notice_enable == 1) {
          try { await sendTelegram(projectcache.telegram, req_data); }
          catch (error) {

          }

        }
        return response;
      }
    }
    catch (error) {
      return response;
    }
  },
};
