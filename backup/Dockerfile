FROM alpine:3.22
RUN apk add --no-cache restic postgresql17-client tzdata bash
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
  && echo "30 3 * * * /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
CMD ["crond", "-f", "-l", "8"]
