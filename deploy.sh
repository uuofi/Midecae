#!/bin/bash
# تحديث الكود من GitHub وإعادة تشغيل السيرفر

cd /root/medi-care-backend || exit 1
echo "جاري جلب آخر التحديثات من GitHub..."
git pull || { echo "فشل في جلب التحديثات"; exit 1; }

echo "إعادة تثبيت الاعتمادات (npm install)..."
npm install

echo "إعادة تشغيل التطبيق عبر pm2..."
pm2 restart medi-care-backend || pm2 start server.js --name medi-care-backend

echo "تم تحديث ونشر الباك اند بنجاح!"
