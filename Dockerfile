FROM node:20-alpine

WORKDIR /app

# فقط فایل‌های وابستگی رو اول کپی می‌کنیم تا از cache لایه‌های Docker استفاده بشه
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# بقیه سورس
COPY src ./src

# مسیر پیش‌فرض کش داده‌ها داخل کانتینر (روی یک ولوم maple می‌شه)
ENV DATA_DIR=/app/data
ENV PORT=5000

RUN mkdir -p /app/data

EXPOSE 5000

CMD ["node", "src/server.js"]