FROM node:20.17.0-alpine3.20

RUN mkdir -p /app

ENV APP_PATH=/app

WORKDIR $APP_PATH
