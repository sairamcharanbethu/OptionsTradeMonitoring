FROM node:20-alpine AS build

WORKDIR /app

ARG VITE_APP_VERSION=1.4.1
ARG VITE_APP_BUILD_SHA=
ARG VITE_ENABLE_DEV_TRADING_TESTS=false

ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_SHA=$VITE_APP_BUILD_SHA
ENV VITE_ENABLE_DEV_TRADING_TESTS=$VITE_ENABLE_DEV_TRADING_TESTS

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

WORKDIR /usr/share/nginx/html

COPY --from=build /app/dist .
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
