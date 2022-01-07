from node:16
# install git
RUN apt-get update && apt-get install -y git

WORKDIR /app

COPY package.json .
COPY tsconfig.json .
COPY . .

RUN ls -alh

RUN npm install
RUN npm run build

EXPOSE 8000
ENTRYPOINT ["node", "./bin/serum-vial.js"]