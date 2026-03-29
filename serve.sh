PORT=8765
echo "Starting News Gap UI on Port $PORT (Binding to 0.0.0.0 for port forwarding)"
python3 -m http.server $PORT --bind 0.0.0.0
