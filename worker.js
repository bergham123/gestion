// worker.js - Cloudflare Worker للتعامل مع JSON في المستودع عبر GitHub API

// المتغيرات البيئية (تُضبط في wrangler.toml)
// GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

const GITHUB_API = 'https://api.github.com';
const DATA_PATH = 'data'; // المجلد الذي سيحتوي ملفات JSON

// دالة مساعدة لقراءة ملف من المستودع
async function getGitHubFile(filename) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}/${filename}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (response.status === 404) {
    // الملف غير موجود => نعيد مصفوفة فارغة مع sha = null
    return { content: [], sha: null };
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const content = JSON.parse(atob(data.content)); // فك تشفير base64
  return { content, sha: data.sha };
}

// دالة مساعدة لحفظ ملف في المستودع
async function saveGitHubFile(filename, content, sha) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}/${filename}`;
  const body = {
    message: `Update ${filename} via Worker`,
    content: btoa(JSON.stringify(content, null, 2)), // تشفير base64
    sha: sha || undefined
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`GitHub save error: ${JSON.stringify(error)}`);
  }

  return await response.json();
}

// تعيين اسم الملف حسب نوع البيانات
function getFilename(type) {
  const map = {
    'in': 'inventory_in.json',
    'out': 'inventory_out.json',
    'attendance1': 'attendance_group1.json',
    'attendance2': 'attendance_group2.json',
    'hours': 'work_hours.json',
    'fuel': 'fuel.json',
    'todos': 'todos.json'
  };
  return map[type] || null;
}

// ---------- دوال API الأساسية (حفظ، جلب، حذف، تحديث) ----------

// 1. جلب البيانات
async function handleGet(type) {
  const filename = getFilename(type);
  if (!filename) return new Response('Invalid type', { status: 400 });

  const { content } = await getGitHubFile(filename);
  return new Response(JSON.stringify(content), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 2. إضافة سجل جديد
async function handleAdd(type, newRecord) {
  const filename = getFilename(type);
  if (!filename) return new Response('Invalid type', { status: 400 });

  const { content, sha } = await getGitHubFile(filename);
  
  // إضافة id فريد (بسيط: timestamp + رقم عشوائي)
  newRecord.id = Date.now() + Math.floor(Math.random() * 1000);
  content.push(newRecord);

  await saveGitHubFile(filename, content, sha);
  return new Response(JSON.stringify({ success: true, id: newRecord.id }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 3. تحديث سجل (حسب id)
async function handleUpdate(type, id, updatedData) {
  const filename = getFilename(type);
  if (!filename) return new Response('Invalid type', { status: 400 });

  const { content, sha } = await getGitHubFile(filename);
  const index = content.findIndex(record => record.id === id);

  if (index === -1) {
    return new Response('Record not found', { status: 404 });
  }

  // دمج البيانات القديمة مع الجديدة
  content[index] = { ...content[index], ...updatedData };

  await saveGitHubFile(filename, content, sha);
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 4. حذف سجل (حسب id)
async function handleDelete(type, id) {
  const filename = getFilename(type);
  if (!filename) return new Response('Invalid type', { status: 400 });

  const { content, sha } = await getGitHubFile(filename);
  const newContent = content.filter(record => record.id !== id);

  if (newContent.length === content.length) {
    return new Response('Record not found', { status: 404 });
  }

  await saveGitHubFile(filename, newContent, sha);
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ---------- معالج الطلبات الرئيسي ----------
export default {
  async fetch(request, env) {
    // تعيين المتغيرات البيئية
    const GITHUB_TOKEN = env.GITHUB_TOKEN;
    const GITHUB_OWNER = env.GITHUB_OWNER;
    const GITHUB_REPO = env.GITHUB_REPO;

    // السماح بـ CORS (لتتمكن الواجهة من الاتصال)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const action = url.searchParams.get('action');
      const type = url.searchParams.get('type');

      // قراءة الجسم للطلبات POST/PUT
      let body = {};
      if (request.method === 'POST' || request.method === 'PUT') {
        body = await request.json();
      }

      let response;
      switch (request.method) {
        case 'GET':
          if (action === 'get' && type) {
            response = await handleGet(type);
          } else {
            response = new Response('Invalid GET request', { status: 400 });
          }
          break;

        case 'POST':
          if (action === 'add' && type && body.record) {
            response = await handleAdd(type, body.record);
          } else {
            response = new Response('Invalid POST request', { status: 400 });
          }
          break;

        case 'PUT':
          if (action === 'update' && type && body.id && body.data) {
            response = await handleUpdate(type, body.id, body.data);
          } else {
            response = new Response('Invalid PUT request', { status: 400 });
          }
          break;

        case 'DELETE':
          if (action === 'delete' && type && body.id) {
            response = await handleDelete(type, body.id);
          } else {
            response = new Response('Invalid DELETE request', { status: 400 });
          }
          break;

        default:
          response = new Response('Method not allowed', { status: 405 });
      }

      // إضافة رؤوس CORS للرد
      Object.keys(corsHeaders).forEach(key => {
        response.headers.set(key, corsHeaders[key]);
      });

      return response;

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
