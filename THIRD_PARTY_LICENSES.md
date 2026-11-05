# مصادر الواجهة والمكتبات — شركة أفراح الوطن

هذه النسخة تستخدم مكوّنات حقيقية من مشاريع مفتوحة المصدر. لا توجد نسخة بريميوم مدفوعة أو أصول بترخيص شراء.

| المكوّن | المصدر | الترخيص | طريقة الاستخدام |
|---|---|---|---|
| Tabler Dashboard / CSS RTL | https://github.com/tabler/tabler | MIT | `@tabler/core@1.7.1` عبر npm محلياً |
| Tabler SVG Icons | https://github.com/tabler/tabler-icons | MIT | مسارات SVG المصدرية ضمن `web/icons.js` |
| Tabulator Spreadsheet Grid | https://github.com/tabulator-tables/tabulator | MIT | `tabulator-tables@6.7.1` محلياً، لإنشاء قائمة متعددة المواد بجدول قابل للترتيب والتحرير |
| Tajawal Arabic Font | https://github.com/googlefonts/tajawal | SIL Open Font License 1.1 | `@fontsource/tajawal@5.3.0`، ملفات محلية |
| Fontsource | https://github.com/fontsource/fontsource | MIT (الأدوات)، وترخيص الخط OFL | تعبئة ملفات Tajawal بطريقة ذاتية |
| Express | https://github.com/expressjs/express | MIT | الخادم |
| TypeScript | https://github.com/microsoft/TypeScript | Apache-2.0 | شيفرة الخادم |
| cookie-parser | https://github.com/expressjs/cookie-parser | MIT | قراءة كوكيز الجلسات |
| Multer | https://github.com/expressjs/multer | MIT | استلام الصور |

الهوية اللونية العربية وتخطيط الصفحات مخصصة لشركة أفراح الوطن على أساس مكوّنات Tabler.
يجب الاحتفاظ بإشعارات التراخيص ذات الصلة عند إعادة التوزيع.

**تشغيل أوفلاين:** ملفات CSS والخطوط والأيقونات لا تطلب أي CDN أو اتصال خارجي أثناء عمل النظام؛ يجب تثبيت اعتمادات npm مرة واحدة على الخادم عند إعداد الجهاز.

**الحماية:** اختيار قالب وتغيير التصميم لا يغني عن معالجة مشكلات الحماية الأخرى في نسخة الخادم التجريبية.
