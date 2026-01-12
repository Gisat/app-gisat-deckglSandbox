# Use the official Python 3.10 slim image as a parent image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container at /app
COPY requirements.txt .

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend application code into the container at /app
# This includes wsgi.py and the app/ directory
COPY . .

# Create the data directory where the geoparquet file will be mounted
RUN mkdir -p /app/data

# Make port 5000 available to the world outside this container
EXPOSE 5000

# Define the default path for the data file inside the container.
# This can be overridden at runtime using docker's -e flag or docker-compose environment section.
ENV GEOPARQUET_PATH=/app/data/egms_optimized_be.geoparquet

# Run the application using Gunicorn
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "wsgi:application"]

