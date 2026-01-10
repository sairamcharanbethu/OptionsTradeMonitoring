# Step 1: Serve the application using Nginx
FROM nginx:alpine

WORKDIR /usr/share/nginx/html

# Copy the pre-built assets from the CI runner to the Nginx html directory
COPY dist .

# Copy a custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
